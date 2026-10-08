document.getElementById("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  const btn = document.getElementById("submit");
  err.classList.remove("show");
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const confirm = document.getElementById("confirm").value;
  const allowlist = document.getElementById("allowlist").value.split("\n").map(s => s.trim()).filter(Boolean);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    err.textContent = "Enter a valid email address.";
    err.classList.add("show");
    return;
  }
  if (password.length < 8) {
    err.textContent = "Password must be at least 8 characters.";
    err.classList.add("show");
    return;
  }
  if (password !== confirm) {
    err.textContent = "The passwords don't match.";
    err.classList.add("show");
    return;
  }
  btn.disabled = true;
  try {
    const r = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, allowlist }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Setup failed.");
    location.href = "/login.html";
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.add("show");
    btn.disabled = false;
  }
});
