  // Firebase Authentication(Googleログイン)の初期化。
  // firebaseConfigのapiKeyは公開情報として扱って問題ない値(アクセス制御はFirestore
  // セキュリティルール側で行う)。
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
  import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
    from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

  const firebaseConfig = {
    apiKey: "AIzaSyCi6z5qUL6Zm3tqD0_5_CjASXZosddUJ6c",
    authDomain: "cyber-portal-899a8.firebaseapp.com",
    projectId: "cyber-portal-899a8",
    storageBucket: "cyber-portal-899a8.firebasestorage.app",
    messagingSenderId: "706319847786",
    appId: "1:706319847786:web:e616f93c8b01939591d513",
    measurementId: "G-Y5QSH4RLMC",
  };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  window.__cyberPortalAuth = auth;

  const gate = document.getElementById("auth-gate");
  const signinBtn = document.getElementById("auth-gate-signin-btn");
  const statusEl = document.getElementById("auth-gate-status");

  // 未ログイン中はページのスクロールを止める。#auth-gate は position:fixed で
  // ビューポートを覆うが、その裏の #view-home は hidden されず実寸でレイアウトされる
  // ため、スクロールするとゲート下端から認証済み画面が覗いてしまう(スマホで顕著)。
  // ログイン成功時に解除する。
  const lockScroll = (on) => { document.documentElement.style.overflow = on ? "hidden" : ""; };
  lockScroll(true);

  // ログイン方式:
  //  - まず signInWithPopup(ポップアップ)。GitHub Pages は COOP ヘッダを付けない
  //    ので opener と通信でき、これが最も確実。
  //  - signInWithRedirect は authDomain(*.firebaseapp.com)とアプリのドメイン
  //    (github.io)が別なため、モバイルブラウザのストレージ分割でリダイレクト
  //    往復中の認証状態を読み戻せず「ログイン画面から進まない」ことがある。
  //    ポップアップが使えない環境(ブロック等)のときだけフォールバックで使う。
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  console.log("[auth] init: authDomain=", firebaseConfig.authDomain, "current URL=", location.href);

  let signingIn = false;
  signinBtn.addEventListener("click", async () => {
    if (signingIn) return;
    signingIn = true;
    statusEl.textContent = "ログイン中…";
    try {
      console.log("[auth] signInWithPopup: calling...");
      await signInWithPopup(auth, provider);
      // 成功時は onAuthStateChanged がゲートを閉じる。
    } catch (err) {
      console.warn("[auth] signInWithPopup failed:", err && err.code, err && err.message);
      const code = (err && err.code) || "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // ユーザーが閉じた/連打しただけ。何もしないで再操作を待つ。
        statusEl.textContent = "";
      } else {
        // ポップアップがブロック/未対応の環境 → リダイレクト方式にフォールバック。
        statusEl.textContent = "Googleのログイン画面へ移動します…";
        try {
          console.log("[auth] falling back to signInWithRedirect...");
          await signInWithRedirect(auth, provider);
        } catch (err2) {
          console.error("[auth] signInWithRedirect failed:", err2);
          statusEl.textContent = "ログインに失敗しました(" + (err2.code || err2.message) + ")。もう一度お試しください。";
        }
      }
    } finally {
      signingIn = false;
    }
  });

  window.__cyberPortalSignOut = () => signOut(auth);

  // リダイレクトでGoogleから戻ってきた直後の結果を受け取る(エラー時のメッセージ表示用)。
  console.log("[auth] calling getRedirectResult...");
  getRedirectResult(auth)
    .then((result) => {
      console.log("[auth] getRedirectResult resolved. result=", result, "user=", result && result.user);
    })
    .catch((err) => {
      console.error("[auth] getRedirectResult failed:", err.code, err.message, err);
      statusEl.textContent = "ログインに失敗しました(" + (err.code || err.message) + ")。もう一度お試しください。";
    });

  onAuthStateChanged(auth, (user) => {
    console.log("[auth] onAuthStateChanged fired. user=", user);
    if (user) {
      // 注意: #auth-gate は style="display:flex" をインライン指定しているため、
      // hidden属性だけではUAスタイルシート([hidden]{display:none})が
      // インラインstyleに負けて非表示にならない。display を直接操作する。
      gate.style.display = "none";
      gate.hidden = true;
      lockScroll(false);
      document.dispatchEvent(new CustomEvent("cyberportal:authready", { detail: { uid: user.uid, email: user.email } }));
    } else {
      gate.style.display = "flex";
      gate.hidden = false;
      lockScroll(true);
      statusEl.textContent = "";
    }
  });
