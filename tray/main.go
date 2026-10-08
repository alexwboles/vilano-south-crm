// VilanoTray — Windows system-tray launcher for the Vilano South GR CRM.
// Cross-compiled from Linux: GOOS=windows GOARCH=amd64 go build
//
// Responsibilities:
//   - start `node server.js` hidden (no console window) using the bundled
//     portable Node, with SEED=0 so installed copies start at the /setup wizard
//   - poll /health until the server is up, then open the browser (first run)
//   - tray menu: Open CRM, Connect phone, Restart server, View logs, Quit
//   - crash recovery with backoff + file logging (5 MB cap, one roll)
//   - register itself for Windows logon via HKCU Run (no admin needed)
package main

import (
	_ "embed"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/getlantern/systray"
	"golang.org/x/sys/windows/registry"
)

//go:embed icon-running.ico
var iconRunning []byte

//go:embed icon-stopped.ico
var iconStopped []byte

const (
	appName    = "Vilano CRM"
	runKeyName = "VilanoCRM"
	serverPort = "3000"
	logMaxSize = 5 * 1024 * 1024 // 5 MB, then roll once
)

var (
	firstrun   = flag.Bool("firstrun", false, "open the browser once the server is up")
	exeDir     string
	logPath    string
	nodeBin    string
	serverCmd  *exec.Cmd
	serverMu   sync.Mutex // serializes start/stop so a crash can't double-start
	quitting   bool       // set on Quit so a sleeping watcher doesn't resurrect the server
	logFile    *os.File
	backoff    = time.Second
)

func logf(format string, args ...interface{}) {
	msg := fmt.Sprintf(time.Now().Format("2006-01-02 15:04:05 ")+format+"\n", args...)
	fmt.Print(msg)
	if logFile != nil {
		rotateLog()
		logFile.WriteString(msg)
	}
}

// rotateLog rolls logs/server.log -> server.log.1 once it passes logMaxSize.
func rotateLog() {
	st, err := logFile.Stat()
	if err != nil || st.Size() < logMaxSize {
		return
	}
	logFile.Close()
	os.Rename(logPath, logPath+".1")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		logFile = nil
		return
	}
	logFile = f
}

func findNode() string {
	candidate := filepath.Join(exeDir, "nodejs", "node.exe")
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	if p, err := exec.LookPath("node"); err == nil {
		return p
	}
	return ""
}

func startServer() error {
	serverMu.Lock()
	defer serverMu.Unlock()
	stopServerLocked()
	if nodeBin == "" {
		return fmt.Errorf("node runtime not found")
	}
	cmd := exec.Command(nodeBin, "server.js")
	cmd.Dir = exeDir
	cmd.Env = append(os.Environ(),
		"SEED=0", // installed copies never auto-seed demo data
		"PORT="+serverPort,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	serverCmd = cmd
	go io.Copy(logWriter{}, stdout)
	go io.Copy(logWriter{}, stderr)
	go watchServer(cmd)
	logf("server started (pid %d)", cmd.Process.Pid)
	preventSleep() // keep the PC awake while the CRM serves phones
	backoff = time.Second
	return nil
}

// preventSleep tells Windows not to sleep while the CRM server is running,
// so phones can reach it at any hour. allowSleep restores normal behavior.
func preventSleep() {
	setThreadExecutionState.Call(esContinuous | esSystemRequired)
	logf("sleep prevention on (server running)")
}

func allowSleep() {
	setThreadExecutionState.Call(esContinuous)
	logf("sleep prevention off")
}

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	setThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
)

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

// logWriter funnels the node process output into the tray log.
type logWriter struct{}

func (logWriter) Write(p []byte) (int, error) {
	if logFile != nil {
		rotateLog()
		return logFile.Write(p)
	}
	return len(p), nil
}

func stopServer() {
	serverMu.Lock()
	defer serverMu.Unlock()
	stopServerLocked()
}

// stopServerLocked kills the node process; caller must hold serverMu.
func stopServerLocked() {
	if serverCmd != nil && serverCmd.Process != nil {
		serverCmd.Process.Kill()
		serverCmd.Wait()
		serverCmd = nil
	}
	allowSleep()
}

// watchServer restarts the node process if it dies unexpectedly.
func watchServer(cmd *exec.Cmd) {
	waitErr := cmd.Wait()
	serverMu.Lock()
	if quitting || serverCmd != cmd {
		serverMu.Unlock()
		return // replaced by a manual restart, or we're quitting: not a crash
	}
	serverCmd = nil
	serverMu.Unlock()
	systray.SetIcon(iconStopped)
	systray.SetTooltip(appName + " — server stopped, restarting…")
	logf("server exited (%v); restarting in %s", waitErr, backoff)
	time.Sleep(backoff)
	if backoff < 30*time.Second {
		backoff *= 2
	}
	if err := startServer(); err != nil {
		logf("restart failed: %v", err)
		systray.SetTooltip(appName + " — server failed to start (see logs)")
	}
}

func waitHealthy(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://127.0.0.1:" + serverPort + "/health")
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return true
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

func openBrowser(url string) {
	// Default-browser open without a console window.
	exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
}

// ensureAutoStart registers the tray for Windows logon (HKCU — no admin).
func ensureAutoStart() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		logf("could not open Run key: %v", err)
		return
	}
	defer k.Close()
	cur, _, err := k.GetStringValue(runKeyName)
	want := `"` + exe + `"`
	if err != nil || cur != want {
		if err := k.SetStringValue(runKeyName, want); err != nil {
			logf("could not set Run key: %v", err)
			return
		}
		logf("registered for start at logon")
	}
}

func onReady() {
	systray.SetIcon(iconStopped)
	systray.SetTitle(appName)
	systray.SetTooltip(appName + " — starting…")

	mOpen := systray.AddMenuItem("Open CRM", "Open the CRM in your browser")
	mPhone := systray.AddMenuItem("Connect phone", "Show the QR code to open the CRM on your phone")
	systray.AddSeparator()
	mRestart := systray.AddMenuItem("Restart server", "Restart the CRM server")
	mLogs := systray.AddMenuItem("View logs", "Open the server log file")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Stop the server and exit")

	ensureAutoStart()

	if err := startServer(); err != nil {
		logf("failed to start server: %v", err)
		systray.SetTooltip(appName + " — failed to start (see logs)")
	} else if waitHealthy(30 * time.Second) {
		systray.SetIcon(iconRunning)
		systray.SetTooltip(appName + " — running")
		if *firstrun {
			openBrowser("http://127.0.0.1:" + serverPort + "/")
		}
	} else {
		logf("server did not become healthy in 30s")
		systray.SetTooltip(appName + " — server not responding (see logs)")
	}

	go func() {
		for {
			select {
			case <-mOpen.ClickedCh:
				openBrowser("http://127.0.0.1:" + serverPort + "/")
			case <-mPhone.ClickedCh:
				openBrowser("http://127.0.0.1:" + serverPort + "/phone")
			case <-mRestart.ClickedCh:
				logf("manual restart requested")
				systray.SetIcon(iconStopped)
				if err := startServer(); err != nil {
					logf("restart failed: %v", err)
				} else if waitHealthy(30 * time.Second) {
					systray.SetIcon(iconRunning)
					systray.SetTooltip(appName + " — running")
				}
			case <-mLogs.ClickedCh:
				exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", logPath).Start()
			case <-mQuit.ClickedCh:
				logf("quit requested")
				serverMu.Lock()
				quitting = true
				serverMu.Unlock()
				stopServer()
				systray.Quit()
				return
			}
		}
	}()
}

func onExit() {
	stopServer()
	if logFile != nil {
		logFile.Close()
	}
}

func main() {
	flag.Parse()
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot locate executable:", err)
		os.Exit(1)
	}
	exeDir = filepath.Dir(exe)
	if err := os.MkdirAll(filepath.Join(exeDir, "logs"), 0755); err != nil {
		fmt.Fprintln(os.Stderr, "cannot create logs dir:", err)
		os.Exit(1)
	}
	logPath = filepath.Join(exeDir, "logs", "server.log")
	logFile, err = os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot open log file:", err)
		os.Exit(1)
	}
	nodeBin = findNode()
	if nodeBin == "" {
		logf("WARNING: no node runtime found next to the tray exe or on PATH")
	}
	systray.Run(onReady, onExit)
}
