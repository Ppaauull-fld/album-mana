import { requireAuth } from "./firebase.js";

(async () => {
  document.documentElement.classList.add("auth-checking");
  const user = await requireAuth({ redirect: true });
  if (user) document.documentElement.classList.remove("auth-checking");
})();
