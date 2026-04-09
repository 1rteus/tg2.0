import "./style.css";
import { initializeApp } from "firebase/app";
import {
  deleteUser,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import {
  arrayUnion,
  arrayRemove,
  collection,
  documentId,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  limit,
  serverTimestamp,
  setDoc,
  deleteDoc,
  writeBatch,
  updateDoc,
  where,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const appNode = document.querySelector<HTMLDivElement>("#app");
if (!appNode) throw new Error("Missing #app");

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const requiredFirebase = [
  firebaseConfig.apiKey,
  firebaseConfig.authDomain,
  firebaseConfig.projectId,
  firebaseConfig.messagingSenderId,
  firebaseConfig.appId,
];
const isFirebaseReady = requiredFirebase.every(Boolean);
const stickers = ["🐼", "🦊", "🐱", "🐸", "🦄", "🐻", "🌸", "⚡"];
let activeChatId = "";
let activePeerId = "";
const THEME_KEY = "tg_theme";
const profileCache = new Map<string, Profile>();
let currentProfile: Profile | null = null;
const ADMIN_SHOW_DELETED_KEY = "tg_admin_show_deleted";
let mobileView: "list" | "chat" = "list";

type ThemeMode = "light" | "dark";
type MessageDoc = {
  id?: string;
  senderId: string;
  text: string;
  createdAt?: { toMillis?: () => number };
  readBy?: string[];
  editedAt?: unknown;
  deleted?: boolean;
  deletedAt?: unknown;
  deletedBy?: string;
  deletedText?: string;
};

type Profile = {
  uid: string;
  email: string;
  username: string;
  nickname: string;
  bio: string;
  avatarUrl: string;
  avatarSticker: string;
};

type ChatDoc = {
  type?: "dm" | "group";
  title?: string;
  avatarSticker?: string;
  avatarUrl?: string;
  participants: string[];
  admins?: string[];
  updatedAt?: unknown;
  lastMessage?: string;
  createdAt?: unknown;
  createdBy?: string;
  typing?: Record<string, unknown>;
};

if (!isFirebaseReady) {
  appNode.innerHTML = `
    <main class="shell center">
      <section class="card">
        <h1>Нужно подключить Firebase</h1>
        <p>Создай файл <code>.env.local</code> из <code>.env.example</code> и впиши ключи. После этого регистрация и чаты заработают.</p>
      </section>
    </main>
  `;
  throw new Error("Firebase env variables missing");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[char] ?? char;
  });

const chatIdFromUsers = (a: string, b: string): string => [a, b].sort().join("_");
const usernameAllowed = (value: string): boolean => /^[a-zA-Z0-9_]+$/.test(value);
const normalizeUsername = (rawUsername: string): string => {
  const username = rawUsername.trim().toLowerCase();
  if (username.length < 3 || username.length > 20 || !usernameAllowed(username)) {
    throw new Error("Username должен быть 3-20 символов: буквы, цифры, _");
  }
  return username;
};
const usernameToEmail = (username: string): string => `${username}@tg.local`;
const isAdmin = (profile: Profile): boolean => profile.username === "admin";
const readAdminShowDeleted = (): boolean => localStorage.getItem(ADMIN_SHOW_DELETED_KEY) === "1";
const setAdminShowDeleted = (value: boolean) => localStorage.setItem(ADMIN_SHOW_DELETED_KEY, value ? "1" : "0");
const isMobile = (): boolean => window.matchMedia?.("(max-width: 960px)")?.matches ?? window.innerWidth <= 960;
const readTheme = (): ThemeMode => {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "dark" ? "dark" : "light";
};
const applyTheme = (theme: ThemeMode) => {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
};
const getThemeToggleText = (theme: ThemeMode): string => (theme === "dark" ? "☀️ Светлая" : "🌙 Тёмная");
const setupMobileViewportLock = () => {
  const updateViewportHeight = () => {
    const height = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
  };
  updateViewportHeight();
  window.visualViewport?.addEventListener("resize", updateViewportHeight);
  window.addEventListener("resize", updateViewportHeight);
  window.addEventListener("orientationchange", updateViewportHeight);

  // iOS Safari can shift the whole page when focusing inputs.
  document.addEventListener("focusin", () => {
    window.setTimeout(() => window.scrollTo(0, 0), 0);
  });
};

const reserveUsername = async (uid: string, rawUsername: string) => {
  const username = normalizeUsername(rawUsername);
  const usernameRef = doc(db, "usernames", username);
  // Don't read before login. If username exists, this becomes an UPDATE and should be blocked by rules.
  await setDoc(usernameRef, { uid }, { merge: false });
  return username;
};

const ensureUserProfile = async (user: User): Promise<Profile> => {
  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) return userSnap.data() as Profile;
  const deletedSnap = await getDoc(doc(db, "deletedUsers", user.uid));
  if (deletedSnap.exists()) {
    throw new Error("Этот аккаунт удален админом");
  }

  const derivedUsername = (user.email || "user").split("@")[0];
  const username = normalizeUsername(derivedUsername);
  try {
    await reserveUsername(user.uid, username);
  } catch {
    // Username may already exist (update blocked). Profile can still be created.
  }
  const profile: Profile = {
    uid: user.uid,
    email: (user.email || "").toLowerCase(),
    username,
    nickname: username,
    bio: "",
    avatarUrl: "",
    avatarSticker: "🐼",
  };
  await setDoc(userRef, { ...profile, createdAt: serverTimestamp() }, { merge: true });
  return profile;
};

const getProfile = async (uid: string): Promise<Profile | null> => {
  const cached = profileCache.get(uid);
  if (cached) return cached;
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  const p = snap.data() as Profile;
  profileCache.set(uid, p);
  return p;
};

const renderAuth = () => {
  appNode.innerHTML = `
  <main class="shell center">
    <section class="card auth-card">
      <h1>tg2.0</h1>
      <p class="subtitle">Регистрация и вход.</p>
      <div class="tabs">
        <button id="tab-signup" class="tab active">Регистрация</button>
        <button id="tab-login" class="tab">Вход</button>
      </div>
      <form id="auth-form" class="form">
        <label>Username
          <input id="auth-username" minlength="3" maxlength="20" pattern="[a-zA-Z0-9_]+" placeholder="user" required />
        </label>
        <label>Password
          <input id="auth-password" type="password" minlength="6" required />
        </label>
        <button type="submit" class="primary-btn">Продолжить</button>
      </form>
      <p id="auth-status" class="status"></p>
    </section>
  </main>`;

  const form = document.getElementById("auth-form") as HTMLFormElement;
  const usernameInput = document.getElementById("auth-username") as HTMLInputElement;
  const status = document.getElementById("auth-status") as HTMLParagraphElement;
  const passwordInput = document.getElementById("auth-password") as HTMLInputElement;
  const tabSignup = document.getElementById("tab-signup") as HTMLButtonElement;
  const tabLogin = document.getElementById("tab-login") as HTMLButtonElement;
  let mode: "signup" | "login" = "signup";

  const updateMode = () => {
    tabSignup.classList.toggle("active", mode === "signup");
    tabLogin.classList.toggle("active", mode === "login");
    status.textContent = "";
  };

  tabSignup.onclick = () => {
    mode = "signup";
    updateMode();
  };
  tabLogin.onclick = () => {
    mode = "login";
    updateMode();
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    status.textContent = "Проверяем...";
    try {
      const username = normalizeUsername(usernameInput.value);
      let nextUser: User | null = null;
      let nextProfile: Profile | null = null;
      if (mode === "signup") {
        const authEmail = usernameToEmail(username);
        const cred = await createUserWithEmailAndPassword(auth, authEmail, passwordInput.value);
        try {
          try {
            await reserveUsername(cred.user.uid, username);
          } catch {
            throw new Error("Такой username уже занят");
          }
          await setDoc(doc(db, "users", cred.user.uid), {
            uid: cred.user.uid,
            email: authEmail,
            username,
            nickname: username,
            bio: "",
            avatarUrl: "",
            avatarSticker: "🐼",
            createdAt: serverTimestamp(),
          });
          nextUser = cred.user;
          nextProfile = {
            uid: cred.user.uid,
            email: authEmail,
            username,
            nickname: username,
            bio: "",
            avatarUrl: "",
            avatarSticker: "🐼",
          };
        } catch (error) {
          await deleteUser(cred.user);
          throw error;
        }
      } else {
        const cred = await signInWithEmailAndPassword(auth, usernameToEmail(username), passwordInput.value);
        nextUser = cred.user;
        nextProfile = await ensureUserProfile(cred.user);
      }
      if (nextUser && nextProfile) {
        renderApp(nextUser, nextProfile);
        return;
      }
      status.textContent = "Готово";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Ошибка авторизации";
    }
  };
};

const renderApp = (user: User, profile: Profile) => {
  const currentTheme = readTheme();
  currentProfile = profile;
  appNode.innerHTML = `
  <main class="shell ${isMobile() ? "mobile" : ""}" data-mobile-view="${escapeHtml(mobileView)}">
    <aside class="left" id="left-panel">
      <header class="left-head mobile-only">
        <div class="logo">Чаты</div>
        <div class="left-actions">
          <button id="open-create-group" class="icon-btn" title="Создать группу">✚</button>
          <button id="open-search" class="icon-btn" title="Поиск">🔎</button>
          <button id="open-mobile-menu" class="icon-btn" title="Меню">☰</button>
        </div>
      </header>
      <header class="left-head desktop-only">
        <div class="logo">tg2.0</div>
        <div class="left-actions">
          ${isAdmin(profile) ? `<button id="open-admin" class="icon-btn" title="Админ">🛠️</button>` : ""}
          <button id="open-create-group-d" class="icon-btn" title="Создать группу">➕</button>
          <button id="open-search-d" class="icon-btn" title="Найти">🔎</button>
        </div>
      </header>
      <section id="chat-list" class="chat-list"></section>
    </aside>

    <section class="right" id="right-panel">
      <header class="topbar desktop-only">
        <button id="open-profile" class="ghost-btn">Профиль</button>
        <button id="theme-toggle" class="ghost-btn">${getThemeToggleText(currentTheme)}</button>
        <button id="logout" class="ghost-btn">Выйти</button>
      </header>
      <div id="content" class="content empty">Пока что чатов нет</div>
    </section>
  </main>

  <div id="modal" class="modal hidden"></div>
  `;

  const desktopLogout = document.getElementById("logout") as HTMLButtonElement | null;
  const desktopTheme = document.getElementById("theme-toggle") as HTMLButtonElement | null;
  if (desktopTheme) {
    desktopTheme.onclick = () => {
      const nextTheme: ThemeMode = readTheme() === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
      desktopTheme.textContent = getThemeToggleText(nextTheme);
    };
  }
  if (desktopLogout) desktopLogout.onclick = async () => signOut(auth);
  const desktopProfileBtn = document.getElementById("open-profile") as HTMLButtonElement | null;
  if (desktopProfileBtn) desktopProfileBtn.onclick = () => openProfileModal(user.uid);
  const desktopSearch = document.getElementById("open-search-d") as HTMLButtonElement | null;
  if (desktopSearch) desktopSearch.onclick = openSearchModal;
  const desktopCreateGroup = document.getElementById("open-create-group-d") as HTMLButtonElement | null;
  if (desktopCreateGroup) desktopCreateGroup.onclick = () => openCreateGroupModal(profile);

  (document.getElementById("open-search") as HTMLButtonElement).onclick = openSearchModal;
  (document.getElementById("open-create-group") as HTMLButtonElement).onclick = () => openCreateGroupModal(profile);
  (document.getElementById("open-mobile-menu") as HTMLButtonElement).onclick = () => {
    openModal(`
      <h2>Меню</h2>
      <div class="form">
        <button type="button" id="m-profile" class="ghost-btn">Профиль</button>
        <button type="button" id="m-theme" class="ghost-btn">${getThemeToggleText(readTheme())}</button>
        <button type="button" id="m-logout" class="ghost-btn">Выйти</button>
      </div>
    `);
    (document.getElementById("m-profile") as HTMLButtonElement).onclick = () => openProfileModal(user.uid);
    (document.getElementById("m-theme") as HTMLButtonElement).onclick = () => {
      const nextTheme: ThemeMode = readTheme() === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
      closeModal();
    };
    (document.getElementById("m-logout") as HTMLButtonElement).onclick = async () => signOut(auth);
  };

  if (isAdmin(profile)) {
    const adminBtn = document.getElementById("open-admin") as HTMLButtonElement | null;
    if (adminBtn) adminBtn.onclick = openAdminModal;
  }

  subscribeChatList(user.uid);
};

const setMobileView = (view: "list" | "chat") => {
  mobileView = view;
  const shell = document.querySelector<HTMLElement>(".shell.mobile");
  if (shell) shell.dataset.mobileView = view;
};

const openGroupInfoModal = async (chatId: string) => {
  const snap = await getDoc(doc(db, "chats", chatId));
  if (!snap.exists()) return;
  const chat = snap.data() as ChatDoc;
  const safeParticipants = (chat.participants || []).filter((uid) => typeof uid === "string" && uid.trim().length > 0);
  const members = await Promise.all(safeParticipants.map((uid) => getProfile(uid)));
  const me = auth.currentUser;
  const isOwner = isGroupOwner(chat, me?.uid);
  const canAdd = canAddGroupMembers(chat, me?.uid);
  const isJrAdmin = isGroupJuniorAdmin(chat, me?.uid);

  const render = (mode: "list" | "edit") => {
    if (mode === "edit") {
      const stickerOptions = ["👥", "🧩", "🎮", "🎧", "⚡", "🔥", "💎", "🪐", "🌙", "⭐", "🍕", "🍀", "🐱", "🐶", "🦊", "🐼"];
      const currentSticker = chat.avatarSticker || "👥";
      return `
        <div class="modal-head">
          <button type="button" id="modal-back" class="ghost-btn small-btn">←</button>
          <h2>Редактировать</h2>
        </div>
        <form id="group-edit-form" class="form" autocomplete="off">
          <label>Название
            <input id="ge-title" maxlength="40" value="${escapeHtml(chat.title || "")}" required />
          </label>
          <label>Аватар (URL, необязательно)
            <input id="ge-avatar-url" placeholder="https://..." value="${escapeHtml(chat.avatarUrl || "")}" />
          </label>
          <p class="sub">или выбери стикер</p>
          <div class="sticker-grid" id="ge-stickers">
            ${stickerOptions
              .map((s) => `<button type="button" class="sticker-btn ${s === currentSticker ? "active" : ""}" data-s="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
              .join("")}
          </div>
          <button type="submit" class="primary-btn">Сохранить</button>
          <p id="ge-status" class="status"></p>
        </form>
      `;
    }

    return `
      <div class="modal-head">
        <button type="button" id="modal-back" class="ghost-btn small-btn">←</button>
        <h2>${escapeHtml(chat.title || "Группа")}</h2>
      </div>
      <p class="sub">${escapeHtml((safeParticipants.length || 0).toString())} участников</p>
      <div class="row">
        ${isOwner ? `<button type="button" id="delete-group" class="ghost-btn danger-btn">Удалить группу</button>` : ""}
        ${isOwner ? `<button type="button" id="edit-group" class="ghost-btn">Редактировать</button>` : ""}
      </div>
      ${
        canAdd
          ? `
        <div class="form">
          <label>Добавить участника (по username)
            <input id="group-add-search" placeholder="Введи username" />
          </label>
          <div id="group-add-results" class="search-list"></div>
        </div>
      `
          : isJrAdmin
            ? `<p class="status">Ты младший админ: можешь добавлять участников</p>`
            : ""
      }
      <div class="admin-list">
        ${members
          .filter(Boolean)
          .map((p) => {
            const prof = p as Profile;
            const av = prof.avatarUrl ? `<img src="${prof.avatarUrl}" alt="" />` : escapeHtml(prof.avatarSticker);
            const owner = chat.createdBy === prof.uid;
            const jrAdmin = (chat.admins || []).includes(prof.uid);
            return `<div class="admin-row">
              <span class="member">
                <span class="avatar small">${av}</span>
                <span>${escapeHtml(prof.nickname)} <span class="muted">@${escapeHtml(prof.username)}</span>${
                  owner ? ` <span class="owner-badge">владелец</span>` : jrAdmin ? ` <span class="admin-badge">админ</span>` : ""
                }</span>
              </span>
              <span class="row">
                ${
                  isOwner && !owner
                    ? `<button type="button" class="crown-btn crown" title="Сделать админом" data-uid="${escapeHtml(prof.uid)}">${
                        jrAdmin ? "👑" : "👑"
                      }</button>`
                    : ""
                }
                ${
                  isOwner && !owner
                    ? `<button type="button" class="ghost-btn kick" data-uid="${escapeHtml(prof.uid)}" data-u="@${escapeHtml(prof.username)}">Исключить</button>`
                    : ""
                }
              </span>
            </div>`;
          })
          .join("")}
      </div>
    `;
  };

  openModal(`
    ${render("list")}
  `, { closeOnOverlay: true });
  const back = document.getElementById("modal-back") as HTMLButtonElement | null;
  if (back) back.onclick = closeModal;

  const delBtn = document.getElementById("delete-group") as HTMLButtonElement | null;
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm("Удалить группу у всех?")) return;
      await deleteChatWithMessages(chatId);
      closeModal();
      if (activeChatId === chatId) {
        const content = document.getElementById("content") as HTMLDivElement;
        activeChatId = "";
        activePeerId = "";
        content.classList.add("empty");
        content.textContent = "Пока что чатов нет";
        if (isMobile()) setMobileView("list");
      }
    };
  }

  const editBtn = document.getElementById("edit-group") as HTMLButtonElement | null;
  if (editBtn) {
    editBtn.onclick = () => {
      openModal(render("edit"), { closeOnOverlay: true });
      const back2 = document.getElementById("modal-back") as HTMLButtonElement | null;
      if (back2) back2.onclick = () => void openGroupInfoModal(chatId);

      const form = document.getElementById("group-edit-form") as HTMLFormElement | null;
      const titleInput = document.getElementById("ge-title") as HTMLInputElement | null;
      const urlInput = document.getElementById("ge-avatar-url") as HTMLInputElement | null;
      const status = document.getElementById("ge-status") as HTMLParagraphElement | null;
      const stickersNode = document.getElementById("ge-stickers") as HTMLDivElement | null;
      if (!form || !titleInput || !urlInput || !status || !stickersNode) return;

      let selectedSticker = chat.avatarSticker || "👥";
      stickersNode.querySelectorAll<HTMLButtonElement>(".sticker-btn").forEach((b) => {
        b.onclick = () => {
          selectedSticker = b.dataset.s || "👥";
          stickersNode.querySelectorAll(".sticker-btn").forEach((n) => n.classList.remove("active"));
          b.classList.add("active");
          urlInput.value = "";
        };
      });

      form.onsubmit = async (e) => {
        e.preventDefault();
        status.textContent = "Сохраняем...";
        const title = titleInput.value.trim();
        const avatarUrl = urlInput.value.trim();
        if (!title) {
          status.textContent = "Название обязательно";
          return;
        }
        try {
          await updateDoc(doc(db, "chats", chatId), {
            title,
            avatarUrl: avatarUrl || "",
            avatarSticker: avatarUrl ? "" : selectedSticker,
            updatedAt: serverTimestamp(),
          });
          closeModal();
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : "Не удалось сохранить";
        }
      };
    };
  }

  document.querySelectorAll<HTMLButtonElement>(".kick").forEach((btn) => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid || "";
      const uname = btn.dataset.u || "";
      if (!me || !uid) return;
      if (!confirm(`Исключить ${uname} из группы?`)) return;
      await updateDoc(doc(db, "chats", chatId), {
        participants: arrayRemove(uid),
        admins: arrayRemove(uid),
        updatedAt: serverTimestamp(),
      });
      await addSystemMessage(chatId, `@${currentProfile?.username || "user"} исключил ${uname}`);
      closeModal();
    };
  });

  document.querySelectorAll<HTMLButtonElement>(".crown").forEach((btn) => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid || "";
      if (!me || !uid) return;
      if (!isOwner) return;
      const currentlyAdmin = (chat.admins || []).includes(uid);
      await updateDoc(doc(db, "chats", chatId), {
        admins: currentlyAdmin ? arrayRemove(uid) : arrayUnion(uid),
        updatedAt: serverTimestamp(),
      });
      closeModal();
    };
  });

  const addInput = document.getElementById("group-add-search") as HTMLInputElement | null;
  const addResults = document.getElementById("group-add-results") as HTMLDivElement | null;
  if (addInput && addResults) {
    let latest = "";
    const renderAdd = async (term: string) => {
      latest = term;
      const u = term.trim().toLowerCase();
      if (!u) {
        addResults.innerHTML = "";
        return;
      }
      const q = query(
        collection(db, "usernames"),
        where(documentId(), ">=", u),
        where(documentId(), "<=", `${u}\uf8ff`),
        limit(20)
      );
      const snap2 = await getDocs(q);
      if (latest !== term) return;
      const cards: string[] = [];
      for (const unameDoc of snap2.docs) {
        const uid = String(unameDoc.data().uid || "");
        if (!uid) continue;
        if ((chat.participants || []).includes(uid)) continue;
        const p = await getProfile(uid);
        if (!p) continue;
        cards.push(`<div class="admin-row">
          <span>${escapeHtml(p.nickname)} <span class="muted">@${escapeHtml(p.username)}</span></span>
          <button type="button" class="ghost-btn add-member" data-uid="${escapeHtml(p.uid)}" data-u="@${escapeHtml(
            p.username
          )}">Добавить</button>
        </div>`);
      }
      addResults.innerHTML = cards.length ? cards.join("") : `<p class="status">Никого не нашли</p>`;
      addResults.querySelectorAll<HTMLButtonElement>(".add-member").forEach((b) => {
        b.onclick = async () => {
          const uid = b.dataset.uid || "";
          const uname = b.dataset.u || "";
          if (!uid || !me) return;
          if (!canAddGroupMembers(chat, me.uid)) return;
          await updateDoc(doc(db, "chats", chatId), {
            participants: arrayUnion(uid),
            updatedAt: serverTimestamp(),
          });
          await addSystemMessage(chatId, `@${currentProfile?.username || "user"} добавил ${uname}`);
          closeModal();
        };
      });
    };
    addInput.oninput = () => void renderAdd(addInput.value);
  }
};

const openUserProfileCard = async (uid: string) => {
  const p = await getProfile(uid);
  if (!p) return;
  openModal(`
    <div class="modal-head">
      <button type="button" id="modal-back" class="ghost-btn small-btn">←</button>
      <h2>Профиль</h2>
    </div>
    <article class="user-card">
      <div class="avatar large">${p.avatarUrl ? `<img src="${p.avatarUrl}" alt="" />` : escapeHtml(p.avatarSticker)}</div>
      <h3>${escapeHtml(p.nickname)}</h3>
      <p>@${escapeHtml(p.username)}</p>
      <p>${escapeHtml(p.bio || "О себе пока ничего нет")}</p>
    </article>
  `);
  const back = document.getElementById("modal-back") as HTMLButtonElement | null;
  if (back) back.onclick = closeModal;
};

const openAdminModal = async () => {
  const showDeleted = readAdminShowDeleted();
  openModal(`
    <h2>Админ</h2>
    <div class="admin-toggle">
      <label class="toggle">
        <input id="admin-show-deleted" type="checkbox" ${showDeleted ? "checked" : ""} />
        <span>Показывать удалённые сообщения в чатах</span>
      </label>
    </div>
    <h3>Пользователи</h3>
    <div id="admin-users" class="admin-list"><p class="status">Загрузка...</p></div>
  `);
  const toggle = document.getElementById("admin-show-deleted") as HTMLInputElement | null;
  if (toggle) {
    toggle.onchange = () => {
      setAdminShowDeleted(Boolean(toggle.checked));
      if (activeChatId) {
        void openChat(activeChatId, activePeerId);
      }
    };
  }
  const usersNode = document.getElementById("admin-users") as HTMLDivElement;

  const usersSnap = await getDocs(query(collection(db, "users"), limit(200)));
  const users = usersSnap.docs.map((d) => d.data() as Profile).sort((a, b) => a.username.localeCompare(b.username));
  usersNode.innerHTML = users
    .map(
      (u) => `<div class="admin-row">
        <span>${escapeHtml(u.nickname)} — @${escapeHtml(u.username)} (${escapeHtml(u.uid.slice(0, 6))}…)</span>
      </div>`
    )
    .join("");
};

const subscribeChatList = (uid: string) => {
  const listNode = document.getElementById("chat-list") as HTMLDivElement;
  const q = query(collection(db, "chats"), where("participants", "array-contains", uid));
  onSnapshot(
    q,
    async (snapshot) => {
      if (snapshot.empty) {
        listNode.innerHTML = `<div class="empty-block">Пока что чатов нет</div>`;
        return;
      }
      const sortedDocs = [...snapshot.docs].sort((a, b) => {
        const aMs = a.data().updatedAt?.toMillis?.() ?? 0;
        const bMs = b.data().updatedAt?.toMillis?.() ?? 0;
        return bMs - aMs;
      });
      const entries = await Promise.all(
        sortedDocs.map(async (chat) => {
          const data = chat.data() as ChatDoc;
          const type = data.type || "dm";
          if (type === "group") {
            const title = data.title || "Группа";
            const avatar = data.avatarUrl
              ? `<img src="${data.avatarUrl}" alt="" />`
              : escapeHtml(data.avatarSticker || "👥");
            return `<button class="chat-item" data-chat="${chat.id}" data-type="group">
              <div class="avatar">${avatar}</div>
              <div>
                <strong>${escapeHtml(title)}</strong>
                <p>${escapeHtml((data.participants?.length || 0).toString())} участников</p>
              </div>
            </button>`;
          }

          const peer = (data.participants as string[]).find((id) => id !== uid);
          if (!peer) return "";
          const p = await getProfile(peer);
          if (!p) return "";
          return `<button class="chat-item" data-chat="${chat.id}" data-peer="${peer}" data-type="dm">
            <div class="avatar">${p.avatarUrl ? `<img src="${p.avatarUrl}" alt="" />` : escapeHtml(p.avatarSticker)}</div>
            <div>
              <strong>${escapeHtml(p.nickname)}</strong>
              <p>@${escapeHtml(p.username)}</p>
            </div>
          </button>`;
        })
      );
      listNode.innerHTML = entries.join("");
      listNode.querySelectorAll<HTMLButtonElement>(".chat-item").forEach((btn) => {
        btn.onclick = () => {
          const chatId = btn.dataset.chat!;
          const type = (btn.dataset.type || "dm") as "dm" | "group";
          if (type === "group") {
            openChat(chatId, "");
          } else {
            openChat(chatId, btn.dataset.peer!);
          }
        };
      });
    },
    () => {
      listNode.innerHTML = `<div class="empty-block">Не удалось загрузить чаты. Обнови страницу.</div>`;
    }
  );
};

const openCreateGroupModal = (meProfile: Profile) => {
  openModal(`
    <h2>Создать группу</h2>
    <form id="group-form" class="form" autocomplete="off">
      <label>Название
        <input id="group-title" maxlength="40" placeholder="Моя группа" required />
      </label>
      <label>Аватар (URL, необязательно)
        <input id="group-avatar-url" placeholder="https://..." />
      </label>
      <div class="sticker-grid" id="group-stickers"></div>
      <label>Добавить участников (по username)
        <input id="group-search" placeholder="Введи username" />
      </label>
      <div id="group-results" class="search-list"></div>
      <div id="group-selected" class="selected-list"></div>
      <button class="primary-btn" type="submit">Создать</button>
      <p id="group-status" class="status"></p>
    </form>
  `);

  const form = document.getElementById("group-form") as HTMLFormElement;
  const titleInput = document.getElementById("group-title") as HTMLInputElement;
  const avatarUrlInput = document.getElementById("group-avatar-url") as HTMLInputElement;
  const stickersNode = document.getElementById("group-stickers") as HTMLDivElement;
  const searchInput = document.getElementById("group-search") as HTMLInputElement;
  const resultsNode = document.getElementById("group-results") as HTMLDivElement;
  const selectedNode = document.getElementById("group-selected") as HTMLDivElement;
  const statusNode = document.getElementById("group-status") as HTMLParagraphElement;

  const stickerOptions = ["👥", "🧩", "🎮", "🎧", "⚡", "🔥", "💎", "🪐", "🌙", "⭐", "🍕", "🍀", "🐱", "🐶", "🦊", "🐼"];
  let selectedSticker = "👥";
  stickersNode.innerHTML = stickerOptions
    .map((s) => `<button type="button" class="sticker-btn ${s === selectedSticker ? "active" : ""}" data-s="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
    .join("");
  stickersNode.querySelectorAll<HTMLButtonElement>(".sticker-btn").forEach((b) => {
    b.onclick = () => {
      selectedSticker = b.dataset.s || "👥";
      stickersNode.querySelectorAll(".sticker-btn").forEach((n) => n.classList.remove("active"));
      b.classList.add("active");
      avatarUrlInput.value = "";
    };
  });

  const selected = new Map<string, Profile>();
  const renderSelected = () => {
    if (selected.size === 0) {
      selectedNode.innerHTML = `<p class="status">Участники не выбраны</p>`;
      return;
    }
    selectedNode.innerHTML = [...selected.values()]
      .map(
        (p) => `<div class="pill">
          <span>@${escapeHtml(p.username)}</span>
          <button type="button" class="pill-x" data-uid="${p.uid}">✕</button>
        </div>`
      )
      .join("");
    selectedNode.querySelectorAll<HTMLButtonElement>(".pill-x").forEach((b) => {
      b.onclick = () => {
        selected.delete(b.dataset.uid || "");
        renderSelected();
      };
    });
  };
  renderSelected();

  let latest = "";
  const renderResults = async (term: string) => {
    latest = term;
    const u = term.trim().toLowerCase();
    if (!u) {
      resultsNode.innerHTML = "";
      return;
    }
    const q = query(
      collection(db, "usernames"),
      where(documentId(), ">=", u),
      where(documentId(), "<=", `${u}\uf8ff`),
      limit(20)
    );
    const snap = await getDocs(q);
    if (latest !== term) return;
    if (snap.empty) {
      resultsNode.innerHTML = `<p class="status">Никого не нашли</p>`;
      return;
    }
    const cards: string[] = [];
    for (const unameDoc of snap.docs) {
      const uid = String(unameDoc.data().uid || "");
      if (!uid || uid === meProfile.uid) continue;
      const p = await getProfile(uid);
      if (!p) continue;
      cards.push(`<div class="admin-row">
        <span>${escapeHtml(p.nickname)} (@${escapeHtml(p.username)})</span>
        <button type="button" class="ghost-btn add-to-group" data-uid="${p.uid}">Добавить</button>
      </div>`);
    }
    resultsNode.innerHTML = cards.join("");
    resultsNode.querySelectorAll<HTMLButtonElement>(".add-to-group").forEach((b) => {
      b.onclick = async () => {
        const uid = b.dataset.uid || "";
        const p = await getProfile(uid);
        if (p) {
          selected.set(uid, p);
          renderSelected();
        }
      };
    });
  };
  searchInput.oninput = () => void renderResults(searchInput.value);

  form.onsubmit = async (e) => {
    e.preventDefault();
    statusNode.textContent = "Создаём...";
    const me = auth.currentUser;
    if (!me) return;
    try {
      const title = titleInput.value.trim();
      if (!title) throw new Error("Название группы обязательно");
      const participants = [me.uid, ...selected.keys()];
      const chatRef = doc(collection(db, "chats"));
      const avatarUrl = avatarUrlInput.value.trim();
      await setDoc(chatRef, {
        type: "group",
        title,
        avatarUrl: avatarUrl || "",
        avatarSticker: avatarUrl ? "" : selectedSticker,
        participants,
        admins: [],
        createdAt: serverTimestamp(),
        createdBy: me.uid,
        updatedAt: serverTimestamp(),
        lastMessage: "",
      } satisfies ChatDoc);
      closeModal();
      openChat(chatRef.id, "");
    } catch (err) {
      statusNode.textContent = err instanceof Error ? err.message : "Не удалось создать группу";
    }
  };
};

const openModal = (html: string, opts?: { closeOnOverlay?: boolean }) => {
  const modal = document.getElementById("modal") as HTMLDivElement;
  modal.classList.remove("hidden");
  modal.innerHTML = `<div class="sheet">${html}</div>`;
  modal.onclick = (event) => {
    const closeOnOverlay = opts?.closeOnOverlay ?? true;
    if (closeOnOverlay && event.target === modal) closeModal();
  };
};

const closeModal = () => {
  const modal = document.getElementById("modal") as HTMLDivElement;
  modal.classList.add("hidden");
  modal.innerHTML = "";
};

const addSystemMessage = async (chatId: string, text: string) => {
  await setDoc(doc(collection(db, "chats", chatId, "messages")), {
    senderId: "system",
    text,
    readBy: [],
    createdAt: serverTimestamp(),
  });
};

const deleteChatWithMessages = async (chatId: string) => {
  const messagesSnap = await getDocs(collection(db, "chats", chatId, "messages"));
  let batch = writeBatch(db);
  let count = 0;
  for (const m of messagesSnap.docs) {
    batch.delete(m.ref);
    count += 1;
    if (count >= 400) {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
  await deleteDoc(doc(db, "chats", chatId));
};

const isGroupOwner = (chat: ChatDoc, uid: string | undefined | null): boolean => Boolean(uid && chat.createdBy && chat.createdBy === uid);
const isGroupJuniorAdmin = (chat: ChatDoc, uid: string | undefined | null): boolean => Boolean(uid && (chat.admins || []).includes(uid));
const canAddGroupMembers = (chat: ChatDoc, uid: string | undefined | null): boolean =>
  isGroupOwner(chat, uid) || isGroupJuniorAdmin(chat, uid);

const openMessageActionsModal = (opts: {
  chatId: string;
  messageId: string;
  currentText: string;
  deleted: boolean;
}) => {
  openModal(`
    <h2>Сообщение</h2>
    <div class="form">
      <label>Текст
        <textarea id="edit-message-text" ${opts.deleted ? "disabled" : ""}>${escapeHtml(opts.currentText || "")}</textarea>
      </label>
      <div class="row">
        <button type="button" id="edit-save" class="primary-btn" ${opts.deleted ? "disabled" : ""}>Сохранить</button>
        <button type="button" id="edit-delete" class="ghost-btn danger-btn">Удалить</button>
      </div>
      <p id="edit-status" class="status"></p>
    </div>
  `);

  const status = document.getElementById("edit-status") as HTMLParagraphElement;
  const saveBtn = document.getElementById("edit-save") as HTMLButtonElement;
  const delBtn = document.getElementById("edit-delete") as HTMLButtonElement;
  const textArea = document.getElementById("edit-message-text") as HTMLTextAreaElement;

  saveBtn.onclick = async () => {
    const me = auth.currentUser;
    if (!me) return;
    status.textContent = "Сохраняем...";
    try {
      const next = textArea.value.trim();
      if (!next) throw new Error("Текст не может быть пустым");
      await updateDoc(doc(db, "chats", opts.chatId, "messages", opts.messageId), {
        text: next,
        editedAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "chats", opts.chatId), { updatedAt: serverTimestamp(), lastMessage: next });
      closeModal();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Не удалось сохранить";
    }
  };

  delBtn.onclick = async () => {
    const me = auth.currentUser;
    if (!me) return;
    if (!confirm("Удалить сообщение у всех?")) return;
    status.textContent = "Удаляем...";
    try {
      await updateDoc(doc(db, "chats", opts.chatId, "messages", opts.messageId), {
        deleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: me.uid,
        deletedText: opts.currentText || "",
        text: "",
      });
      await updateDoc(doc(db, "chats", opts.chatId), {
        updatedAt: serverTimestamp(),
        lastMessage: "Сообщение удалено",
      });
      closeModal();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Не удалось удалить";
    }
  };
};

const openProfileModal = async (uid: string) => {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return;
  const profile = snap.data() as Profile;
  openModal(`
    <div class="modal-head">
      <button type="button" id="modal-back" class="ghost-btn small-btn">←</button>
      <h2>Профиль</h2>
    </div>
    <form id="profile-form" class="form">
      <label>Никнейм
        <input id="pf-nickname" maxlength="30" value="${escapeHtml(profile.nickname || "")}" required />
      </label>
      <label>О себе
        <textarea id="pf-bio" maxlength="160">${escapeHtml(profile.bio || "")}</textarea>
      </label>
      <label>Аватар (ссылка на фото)
        <input id="pf-avatar-url" type="url" placeholder="https://..." value="${escapeHtml(profile.avatarUrl || "")}" />
      </label>
      <p class="sub">или выбери стикер</p>
      <div class="stickers">${stickers
        .map((s) => `<button type="button" class="sticker ${s === profile.avatarSticker ? "selected" : ""}" data-sticker="${s}">${s}</button>`)
        .join("")}</div>
      <button class="primary-btn" type="submit">Сохранить</button>
      <p id="pf-status" class="status"></p>
    </form>
  `, { closeOnOverlay: false });

  const back = document.getElementById("modal-back") as HTMLButtonElement | null;
  if (back) back.onclick = closeModal;

  const form = document.getElementById("profile-form") as HTMLFormElement;
  const nickname = document.getElementById("pf-nickname") as HTMLInputElement;
  const bio = document.getElementById("pf-bio") as HTMLTextAreaElement;
  const avatarUrlInput = document.getElementById("pf-avatar-url") as HTMLInputElement;
  const status = document.getElementById("pf-status") as HTMLParagraphElement;
  let selectedSticker = profile.avatarSticker || stickers[0];
  document.querySelectorAll<HTMLButtonElement>(".sticker").forEach((btn) => {
    btn.onclick = () => {
      selectedSticker = btn.dataset.sticker || stickers[0];
      document.querySelectorAll(".sticker").forEach((el) => el.classList.remove("selected"));
      btn.classList.add("selected");
    };
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    status.textContent = "Сохраняем...";
    try {
      const avatarUrl = avatarUrlInput.value.trim();
      await updateDoc(doc(db, "users", uid), {
        nickname: nickname.value.trim(),
        bio: bio.value.trim(),
        avatarSticker: selectedSticker,
        avatarUrl,
      });
      closeModal();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Не удалось сохранить профиль";
    }
  };
};

const openSearchModal = () => {
  openModal(`
  <h2>Поиск друга</h2>
  <form id="search-form" class="form" autocomplete="off">
    <label>Username
      <input id="search-input" placeholder="Введи username" required />
    </label>
    <div id="search-result" class="search-list"></div>
  </form>`);

  const input = document.getElementById("search-input") as HTMLInputElement;
  const result = document.getElementById("search-result") as HTMLDivElement;
  let latestTerm = "";

  const renderSearchResults = async (term: string) => {
    latestTerm = term;
    const username = term.trim().toLowerCase();
    if (username.length < 1) {
      result.innerHTML = `<p class="status">Начни вводить username</p>`;
      return;
    }
    const q = query(
      collection(db, "usernames"),
      where(documentId(), ">=", username),
      where(documentId(), "<=", `${username}\uf8ff`),
      limit(20)
    );
    const usernameSnap = await getDocs(q);
    if (latestTerm !== term) return;
    if (usernameSnap.empty) {
      result.innerHTML = `<p class="status">Никого не нашли</p>`;
      return;
    }
    const cards: string[] = [];
    for (const unameDoc of usernameSnap.docs) {
      const uid = String(unameDoc.data().uid || "");
      const userDoc = await getDoc(doc(db, "users", uid));
      if (!userDoc.exists()) continue;
      const p = userDoc.data() as Profile;
      cards.push(`
      <article class="user-card" data-uid="${p.uid}">
        <div class="avatar large">${p.avatarUrl ? `<img src="${p.avatarUrl}" alt="" />` : p.avatarSticker}</div>
        <h3>${escapeHtml(p.nickname)}</h3>
        <p>@${escapeHtml(p.username)}</p>
        <p>${escapeHtml(p.bio || "О себе пока ничего нет")}</p>
        <button type="button" class="round-msg start-chat" data-uid="${p.uid}">💬</button>
      </article>`);
    }
    result.innerHTML = cards.join("");
    result.querySelectorAll<HTMLButtonElement>(".start-chat").forEach((startBtn) => {
      startBtn.onclick = async () => {
        const statusNode = document.getElementById("search-result") as HTMLDivElement;
        try {
          const me = auth.currentUser;
          const uid = startBtn.dataset.uid || "";
          if (!me) {
            throw new Error("Сессия истекла, войди снова");
          }
          if (me.uid === uid) {
            throw new Error("Нельзя открыть чат с самим собой");
          }
          const chatId = chatIdFromUsers(me.uid, uid);
          await setDoc(
            doc(db, "chats", chatId),
            { participants: [me.uid, uid], updatedAt: serverTimestamp(), lastMessage: "" },
            { merge: true }
          );
          closeModal();
          await openChat(chatId, uid);
        } catch (error) {
          statusNode.insertAdjacentHTML(
            "afterbegin",
            `<p class="status">${escapeHtml(error instanceof Error ? error.message : "Не удалось открыть чат")}</p>`
          );
        }
      };
    });
  };

  input.oninput = () => {
    void renderSearchResults(input.value);
  };
  void renderSearchResults("");
};

const renderMessage = (params: {
  message: MessageDoc;
  mine: boolean;
  peerId: string;
  sender: Profile | null;
  showSenderLabel: boolean;
  canEdit: boolean;
  showDeleted: boolean;
}): string => {
  const { message, mine, peerId, sender, showSenderLabel, canEdit, showDeleted } = params;
  const isSystem = message.senderId === "system";
  const body = message.deleted ? (showDeleted ? String(message.deletedText || "Сообщение удалено") : "") : String(message.text || "");
  const read = peerId ? Boolean(message.readBy?.includes(peerId)) : false;
  const checks = mine && peerId ? (read ? "✓✓" : "✓") : "";
  const edited = Boolean(message.editedAt) && !message.deleted;
  const avatar = sender?.avatarUrl
    ? `<img src="${sender.avatarUrl}" alt="" />`
    : escapeHtml(sender?.avatarSticker || "👤");
  const username = sender ? `@${sender.username}` : "@unknown";
  return `
    <div class="msg-row ${mine ? "mine" : ""} ${isSystem ? "system" : ""}" data-mid="${escapeHtml(message.id || "")}">
      <div class="msg">
        <p class="${message.deleted ? "muted" : ""}">${escapeHtml(body)}</p>
        <div class="msg-bottom">
          ${
            isSystem
              ? `<span></span>`
              : showSenderLabel && sender
              ? `<button type="button" class="msg-user user-open" data-uid="${escapeHtml(sender.uid)}">${escapeHtml(username)}</button>`
              : `<span></span>`
          }
          <span class="msg-meta">${message.deleted ? "удалено" : edited ? "изменено" : ""} ${checks}</span>
        </div>
      </div>
      ${
        isSystem
          ? `<div class="avatar msg-avatar"></div>`
          : sender
          ? `<button type="button" class="avatar msg-avatar avatar-btn user-open" data-uid="${escapeHtml(sender.uid)}">${avatar}</button>`
          : `<div class="avatar msg-avatar">${avatar}</div>`
      }
      ${canEdit && !isSystem ? `<button type="button" class="msg-actions" title="Действия">⋯</button>` : ""}
    </div>
  `;
};

const openChat = async (chatId: string, peerId: string) => {
  activeChatId = chatId;
  activePeerId = peerId;
  const content = document.getElementById("content") as HTMLDivElement;
  const chatSnap = await getDoc(doc(db, "chats", chatId));
  const chat = chatSnap.exists() ? (chatSnap.data() as ChatDoc) : null;
  const type = chat?.type || (peerId ? "dm" : "group");
  const peer = peerId ? await getProfile(peerId) : null;
  if (isMobile()) setMobileView("chat");
  content.classList.remove("empty");
  content.innerHTML = `
    <section class="chat-room">
      <header class="chat-head">
        <button id="back-mobile" class="ghost-btn small-btn mobile-only" type="button">←</button>
        <button id="chat-avatar" type="button" class="avatar avatar-btn">${
          type === "group"
            ? chat?.avatarUrl
              ? `<img src="${chat.avatarUrl}" alt="" />`
              : escapeHtml(chat?.avatarSticker || "👥")
            : peer?.avatarUrl
              ? `<img src="${peer.avatarUrl}" alt="" />`
              : escapeHtml(peer?.avatarSticker || "👤")
        }</button>
        <div>
          <button id="chat-title" type="button" class="title-btn">
            ${escapeHtml(type === "group" ? chat?.title || "Группа" : peer?.nickname || "Пользователь")}
          </button>
          <p>${
            type === "group"
              ? escapeHtml(`${(chat?.participants || []).filter((u) => typeof u === "string" && u.trim().length > 0).length} участников`)
              : `@${escapeHtml(peer?.username || "")}`
          }</p>
        </div>
        <button id="collapse-chat" class="ghost-btn small-btn desktop-only" type="button">Свернуть</button>
      </header>
      <div id="messages" class="messages"></div>
      <form id="send-form" class="send">
        <input id="message-input" placeholder="Сообщение" />
        <button class="primary-btn">Отправить</button>
      </form>
      <p id="typing" class="status typing"></p>
      <p id="send-status" class="status"></p>
    </section>
  `;

  const messagesNode = document.getElementById("messages") as HTMLDivElement;
  const typingNode = document.getElementById("typing") as HTMLParagraphElement;
  const backBtn = document.getElementById("back-mobile") as HTMLButtonElement | null;
  if (backBtn) {
    backBtn.onclick = () => {
      setMobileView("list");
      activeChatId = "";
      activePeerId = "";
      content.classList.add("empty");
      content.textContent = "Пока что чатов нет";
    };
  }

  const titleBtn = document.getElementById("chat-title") as HTMLButtonElement;
  titleBtn.onclick = () => {
    if (type === "group") void openGroupInfoModal(chatId);
    else if (peerId) void openUserProfileCard(peerId);
  };
  const avatarBtn = document.getElementById("chat-avatar") as HTMLButtonElement;
  avatarBtn.onclick = () => {
    if (type === "group") void openGroupInfoModal(chatId);
    else if (peerId) void openUserProfileCard(peerId);
  };

  const collapseBtn = document.getElementById("collapse-chat") as HTMLButtonElement | null;
  if (collapseBtn) {
    collapseBtn.onclick = () => {
      activeChatId = "";
      activePeerId = "";
      content.classList.add("empty");
      content.textContent = "Пока что чатов нет";
    };
  }

  const meTyping = auth.currentUser;
  let typingTimer: number | undefined;
  const setTyping = async (on: boolean) => {
    if (!meTyping || !currentProfile) return;
    try {
      await updateDoc(doc(db, "chats", chatId), {
        [`typing.${meTyping.uid}`]: on ? { username: currentProfile.username, ts: Date.now() } : null,
      } as Record<string, unknown>);
    } catch {
      // ignore
    }
  };
  const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"));
  onSnapshot(q, async (snapshot) => {
    if (chatId !== activeChatId) return;
    const me = auth.currentUser;
    const showDeleted = Boolean(currentProfile && isAdmin(currentProfile) && readAdminShowDeleted());
    const allDocs = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as MessageDoc) })) as MessageDoc[];
    const docs = showDeleted ? allDocs : allDocs.filter((m) => !m.deleted);
    const senderIds = [...new Set(docs.map((m) => m.senderId).filter((id) => Boolean(id) && id !== "system"))];
    await Promise.all(senderIds.map((id) => getProfile(id)));

    messagesNode.innerHTML = docs
      .map((m) => {
        const mine = m.senderId === me?.uid;
        const sender = m.senderId === "system" ? null : profileCache.get(m.senderId) || null;
        const canEdit = Boolean(me && mine);
        return renderMessage({
          message: m,
          mine,
          peerId,
          sender,
          showSenderLabel: true,
          canEdit,
          showDeleted,
        });
      })
      .join("");
    messagesNode.scrollTop = messagesNode.scrollHeight;
    if (me) {
      snapshot.docs.forEach((docItem) => {
        const d = docItem.data() as MessageDoc;
        if (d.senderId !== me.uid && !d.readBy?.includes(me.uid)) {
          void updateDoc(docItem.ref, { readBy: arrayUnion(me.uid) });
        }
      });
    }

    messagesNode.querySelectorAll<HTMLButtonElement>(".msg-actions").forEach((btn) => {
      btn.onclick = () => {
        const row = btn.closest<HTMLElement>(".msg-row");
        const mid = row?.dataset.mid || "";
        const msg = allDocs.find((m) => m.id === mid);
        if (!msg) return;
        openMessageActionsModal({
          chatId,
          messageId: mid,
          currentText: String(msg.text || msg.deletedText || ""),
          deleted: Boolean(msg.deleted),
        });
      };
    });

    messagesNode.querySelectorAll<HTMLButtonElement>(".user-open").forEach((btn) => {
      btn.onclick = () => {
        const uid = btn.dataset.uid || "";
        if (uid) void openUserProfileCard(uid);
      };
    });
  });

  onSnapshot(doc(db, "chats", chatId), (snap) => {
    const data = snap.data() as any;
    const typing = (data?.typing || {}) as Record<string, { username?: string; ts?: number } | null>;
    const now = Date.now();
    const others = Object.entries(typing)
      .filter(([uid, v]) => uid !== auth.currentUser?.uid && v && (v.ts ? now - v.ts < 4500 : false))
      .map(([, v]) => v?.username)
      .filter(Boolean) as string[];
    typingNode.textContent = others.length ? `@${others[0]} печатает...` : "";
  });

  const form = document.getElementById("send-form") as HTMLFormElement;
  const input = document.getElementById("message-input") as HTMLInputElement;
  const status = document.getElementById("send-status") as HTMLParagraphElement;
  input.oninput = () => {
    void setTyping(true);
    if (typingTimer) window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => void setTyping(false), 1600);
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user) return;
    status.textContent = "Отправляем...";
    try {
      void setTyping(false);
      const text = input.value.trim();
      if (!text) {
        status.textContent = "Напиши сообщение";
        return;
      }
      await setDoc(doc(collection(db, "chats", chatId, "messages")), {
        senderId: user.uid,
        text,
        readBy: [user.uid],
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "chats", chatId), {
        updatedAt: serverTimestamp(),
        lastMessage: text,
        ...(type === "dm"
          ? { participants: arrayUnion(user.uid, activePeerId) }
          : {
              // защитa: иногда в participants попадал пустой uid
              participants: arrayRemove(""),
              admins: arrayRemove(""),
            }),
      });
      input.value = "";
      status.textContent = "";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Не удалось отправить";
    }
  };
};

const bootstrap = async () => {
  setupMobileViewportLock();
  applyTheme(readTheme());
  renderAuth();
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      renderAuth();
      return;
    }
    try {
      const profile = await ensureUserProfile(user);
      renderApp(user, profile);
    } catch (error) {
      await signOut(auth);
      renderAuth();
      const status = document.getElementById("auth-status") as HTMLParagraphElement | null;
      if (status) {
        status.textContent = error instanceof Error ? error.message : "Не удалось войти";
      }
    }
  });
};

bootstrap().catch((error) => {
  appNode.innerHTML = `<main class="shell center"><section class="card"><h1>Ошибка запуска</h1><p>${escapeHtml(
    error instanceof Error ? error.message : "Unknown error"
  )}</p></section></main>`;
});
