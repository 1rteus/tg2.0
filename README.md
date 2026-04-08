# TG Lite Messenger

Простой мессенджер на `Vite + TypeScript + Firebase`, который можно запускать локально и после деплоя на GitHub Pages.

## Что уже есть

- Регистрация и вход (`email + password + username`)
- Профиль: никнейм, описание "о себе", аватар по ссылке или стикер
- Поиск пользователей по `username` через кнопку-лупу
- Создание диалога и обмен сообщениями в реальном времени
- Отправка текстовых сообщений

## Почему без Storage

Проект переведен на полностью бесплатный режим: используется только Firebase Authentication и Cloud Firestore.
`Cloud Storage` не нужен, поэтому фото/видео-файлы в чат не загружаются.

## Запуск

1. Установи зависимости:

```bash
npm install
```

2. Создай `.env.local` из `.env.example` и вставь ключи Firebase.
3. Запусти:

```bash
npm run dev
```

4. Сборка:

```bash
npm run build
```

## Важно для Firebase

В Firebase Console включи:

- Authentication -> Email/Password
- Firestore Database

### Минимальные правила Firestore (пример)

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    match /users/{uid} {
      allow read: if signedIn();
      allow write: if signedIn() && request.auth.uid == uid;
    }
    match /usernames/{name} {
      allow read: if signedIn();
      allow create: if signedIn();
      allow update, delete: if false;
    }
    match /chats/{chatId} {
      allow create: if signedIn() && request.auth.uid in request.resource.data.participants;
      allow read, update: if signedIn() && request.auth.uid in resource.data.participants;
      match /messages/{messageId} {
        allow read: if signedIn() && request.auth.uid in get(/databases/$(database)/documents/chats/$(chatId)).data.participants;
        allow create: if signedIn() && request.auth.uid in get(/databases/$(database)/documents/chats/$(chatId)).data.participants;
      }
    }
  }
}
```

## GitHub Pages

Проект уже настроен с `base: "./"` в `vite.config.ts`, чтобы статика корректно открывалась после публикации.
