  // Firebase Authentication(Googleログイン)の初期化。
  // firebaseConfigのapiKeyは公開情報として扱って問題ない値(アクセス制御はFirestore
  // セキュリティルール側で行う)。
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
  import { getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
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

  // GitHub Pagesが付与するCross-Origin-Opener-Policyヘッダーの影響で、
  // ポップアップ方式(signInWithPopup)は別ウィンドウの開閉を検知できずフリーズするため、
  // 同じタブでGoogleのログイン画面へ遷移するリダイレクト方式を使う。
  console.log("[auth] init: authDomain=", firebaseConfig.authDomain, "current URL=", location.href);

  signinBtn.addEventListener("click", async () => {
    statusEl.textContent = "Googleのログイン画面へ移動します…";
    console.log("[auth] signInWithRedirect: calling...");
    try {
      await signInWithRedirect(auth, new GoogleAuthProvider());
    } catch (err) {
      console.error("[auth] signInWithRedirect failed:", err);
      statusEl.textContent = "ログインに失敗しました(" + (err.code || err.message) + ")。もう一度お試しください。";
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
      document.dispatchEvent(new CustomEvent("cyberportal:authready", { detail: { uid: user.uid, email: user.email } }));
    } else {
      gate.style.display = "flex";
      gate.hidden = false;
      statusEl.textContent = "";
    }
  });
