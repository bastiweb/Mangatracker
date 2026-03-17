const authPages = new Set(["/login", "/register", "/login.html", "/register.html"]);
const currentPath = window.location.pathname;
const isAuthPage = authPages.has(currentPath);

const userEmail = document.getElementById("user-email");
const adminBadge = document.getElementById("admin-badge");
const logoutBtn = document.getElementById("logout-btn");
const adminLink = document.getElementById("admin-link");

async function fetchMe() {
  const response = await fetch("/api/auth/me");
  if (!response.ok) {
    return null;
  }

  const data = await response.json().catch(() => ({}));
  return data.user || null;
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.MangaAuthUser = null;
  window.location.href = "/login";
}

(async () => {
  const user = await fetchMe();
  window.MangaAuthUser = user;

  if (!user && !isAuthPage) {
    window.location.href = "/login";
    return;
  }

  if (user && isAuthPage) {
    const isLogin = currentPath === "/login" || currentPath === "/login.html";
    const isRegister = currentPath === "/register" || currentPath === "/register.html";

    if (isLogin || (isRegister && user.role !== "admin")) {
      window.location.href = "/";
      return;
    }
  }

  if (userEmail) {
    userEmail.textContent = user ? (user.username || user.email) : "";
  }

  if (adminBadge) {
    adminBadge.hidden = !user || user.role !== "admin";
  }

  if (adminLink) {
    adminLink.hidden = !user || user.role !== "admin";
  }

  if (logoutBtn) {
    logoutBtn.hidden = !user;
    logoutBtn.addEventListener("click", logout);
  }
})();
