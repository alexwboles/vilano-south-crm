// Hide the demo-account hint on installed copies (no demo account there).
fetch("/api/demo-available").then(r => r.json()).then(d => {
  if (!d.demo) {
    const note = document.querySelector(".demo-note");
    if (note) note.style.display = "none";
  }
}).catch(() => {});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.classList.remove("show");
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Sign in failed.");
    location.href = "/index.html";
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.add("show");
  }
});
