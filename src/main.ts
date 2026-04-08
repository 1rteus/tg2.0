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

type ThemeMode = "light" | "dark";
type MessageDoc = {
  senderId: string;
  text: string;
  createdAt?: { toMillis?: () => number };
  readBy?: string[];
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
  const usernameSnap = await getDoc(usernameRef);
  if (usernameSnap.exists() && usernameSnap.data().uid !== uid) {
    throw new Error("Такой username уже занят");
  }
  await setDoc(usernameRef, { uid }, { merge: true });
  return username;
};

const findUsernameByUid = async (uid: string): Promise<string | null> => {
  const q = query(collection(db, "usernames"), where("uid", "==", uid), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].id;
};

const createUniqueUsername = async (email: string): Promise<string> => {
  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 14) || "user";
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? base : `${base}_${Math.floor(Math.random() * 9999)}`;
    const candidateRef = doc(db, "usernames", candidate);
    if (!(await getDoc(candidateRef)).exists()) return candidate;
  }
  return `user_${Date.now().toString().slice(-8)}`;
};

const ensureUserProfile = async (user: User): Promise<Profile> => {
  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) return userSnap.data() as Profile;
  const deletedSnap = await getDoc(doc(db, "deletedUsers", user.uid));
  if (deletedSnap.exists()) {
    throw new Error("Этот аккаунт удален админом");
  }

  let username = await findUsernameByUid(user.uid);
  if (!username) {
    username = await createUniqueUsername(user.email || "user");
  }
  await reserveUsername(user.uid, username);
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
        const usernameRef = doc(db, "usernames", username);
        if ((await getDoc(usernameRef)).exists()) {
          throw new Error("Такой username уже занят");
        }
        const authEmail = usernameToEmail(username);
        const cred = await createUserWithEmailAndPassword(auth, authEmail, passwordInput.value);
        try {
          await reserveUsername(cred.user.uid, username);
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
        const usernameDoc = await getDoc(doc(db, "usernames", username));
        if (!usernameDoc.exists()) {
          throw new Error("Пользователь с таким username не найден");
        }
        const uid = String(usernameDoc.data().uid || "");
        if (!uid) {
          throw new Error("Ошибка данных пользователя");
        }
        const profileDoc = await getDoc(doc(db, "users", uid));
        const authEmail = profileDoc.exists()
          ? String((profileDoc.data().email as string) || usernameToEmail(username))
          : usernameToEmail(username);
        const cred = await signInWithEmailAndPassword(auth, authEmail, passwordInput.value);
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
  appNode.innerHTML = `
  <main class="shell">
    <aside class="left">
      <header class="left-head">
        <div class="logo">tg2.0</div>
        <div class="left-actions">
          <button id="open-search" class="icon-btn" title="Найти">🔎</button>
        </div>
      </header>
      <section id="chat-list" class="chat-list"></section>
    </aside>
    <section class="right">
      <header class="topbar">
        <button id="open-profile" class="ghost-btn">${escapeHtml(profile.nickname)}</button>
        <button id="theme-toggle" class="ghost-btn">${getThemeToggleText(currentTheme)}</button>
        <button id="logout" class="ghost-btn">Выйти</button>
      </header>
      <div id="content" class="content empty">Пока что чатов нет</div>
    </section>
  </main>

  <div id="modal" class="modal hidden"></div>
  `;

  const logoutBtn = document.getElementById("logout") as HTMLButtonElement;
  const themeBtn = document.getElementById("theme-toggle") as HTMLButtonElement;
  themeBtn.onclick = () => {
    const nextTheme: ThemeMode = readTheme() === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    themeBtn.textContent = getThemeToggleText(nextTheme);
  };
  logoutBtn.onclick = async () => signOut(auth);
  (document.getElementById("open-profile") as HTMLButtonElement).onclick = () => openProfileModal(user.uid);
  (document.getElementById("open-search") as HTMLButtonElement).onclick = openSearchModal;
  subscribeChatList(user.uid);
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
          const data = chat.data();
          const peer = (data.participants as string[]).find((id) => id !== uid);
          if (!peer) return "";
          const peerSnap = await getDoc(doc(db, "users", peer));
          if (!peerSnap.exists()) return "";
          const p = peerSnap.data() as Profile;
          return `<button class="chat-item" data-chat="${chat.id}" data-peer="${peer}">
          <div class="avatar">${p.avatarUrl ? `<img src="${p.avatarUrl}" alt="" />` : p.avatarSticker}</div>
          <div>
            <strong>${escapeHtml(p.nickname)}</strong>
            <p>@${escapeHtml(p.username)}</p>
          </div>
        </button>`;
        })
      );
      listNode.innerHTML = entries.join("");
      listNode.querySelectorAll<HTMLButtonElement>(".chat-item").forEach((btn) => {
        btn.onclick = () => openChat(btn.dataset.chat!, btn.dataset.peer!);
      });
    },
    () => {
      listNode.innerHTML = `<div class="empty-block">Не удалось загрузить чаты. Обнови страницу.</div>`;
    }
  );
};

const openModal = (html: string) => {
  const modal = document.getElementById("modal") as HTMLDivElement;
  modal.classList.remove("hidden");
  modal.innerHTML = `<div class="sheet">${html}</div>`;
  modal.onclick = (event) => {
    if (event.target === modal) closeModal();
  };
};

const closeModal = () => {
  const modal = document.getElementById("modal") as HTMLDivElement;
  modal.classList.add("hidden");
  modal.innerHTML = "";
};

const openProfileModal = async (uid: string) => {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return;
  const profile = snap.data() as Profile;
  openModal(`
    <h2>Профиль</h2>
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
  `);

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

const renderMessage = (message: MessageDoc, mine: boolean, peerId: string): string => {
  const body = String(message.text || "");
  const read = Boolean(message.readBy?.includes(peerId));
  const checks = mine ? (read ? "✓✓" : "✓") : "";
  return `
    <div class="msg ${mine ? "mine" : ""}">
      ${body ? `<p>${escapeHtml(body)}</p>` : ""}
      ${checks ? `<span class="msg-meta">${checks}</span>` : ""}
    </div>
  `;
};

const openChat = async (chatId: string, peerId: string) => {
  activeChatId = chatId;
  activePeerId = peerId;
  const content = document.getElementById("content") as HTMLDivElement;
  const peerSnap = await getDoc(doc(db, "users", peerId));
  const peer = peerSnap.data() as Profile;
  content.classList.remove("empty");
  content.innerHTML = `
    <section class="chat-room">
      <header class="chat-head">
        <div class="avatar">${peer.avatarUrl ? `<img src="${peer.avatarUrl}" alt="" />` : peer.avatarSticker}</div>
        <div>
          <strong>${escapeHtml(peer.nickname)}</strong>
          <p>@${escapeHtml(peer.username)}</p>
        </div>
        <button id="collapse-chat" class="ghost-btn small-btn" type="button">Свернуть</button>
      </header>
      <div id="messages" class="messages"></div>
      <form id="send-form" class="send">
        <input id="message-input" placeholder="Сообщение" />
        <button class="primary-btn">Отправить</button>
      </form>
      <p id="send-status" class="status"></p>
    </section>
  `;

  const messagesNode = document.getElementById("messages") as HTMLDivElement;
  const collapseBtn = document.getElementById("collapse-chat") as HTMLButtonElement;
  collapseBtn.onclick = () => {
    activeChatId = "";
    activePeerId = "";
    content.classList.add("empty");
    content.textContent = "Пока что чатов нет";
  };
  const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"));
  onSnapshot(q, (snapshot) => {
    if (chatId !== activeChatId) return;
    messagesNode.innerHTML = snapshot.docs
      .map((docItem) => {
        const d = docItem.data() as MessageDoc;
        const mine = d.senderId === auth.currentUser?.uid;
        return renderMessage(d, mine, peerId);
      })
      .join("");
    messagesNode.scrollTop = messagesNode.scrollHeight;
    const me = auth.currentUser;
    if (me) {
      snapshot.docs.forEach((docItem) => {
        const d = docItem.data() as MessageDoc;
        if (d.senderId !== me.uid && !d.readBy?.includes(me.uid)) {
          void updateDoc(docItem.ref, { readBy: arrayUnion(me.uid) });
        }
      });
    }
  });

  const form = document.getElementById("send-form") as HTMLFormElement;
  const input = document.getElementById("message-input") as HTMLInputElement;
  const status = document.getElementById("send-status") as HTMLParagraphElement;

  form.onsubmit = async (event) => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user) return;
    status.textContent = "Отправляем...";
    try {
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
        participants: arrayUnion(user.uid, activePeerId),
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
