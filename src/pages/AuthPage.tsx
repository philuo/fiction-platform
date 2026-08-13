// 登录 / 注册页（未登录时首页展示）：墨枢品牌 · 宣纸墨印风 · 动效登录体验
// 动效：canvas 墨点粒子（随鼠标微扰）+ 流动光晕背景 + 毛玻璃卡片入场 + 印章盖下 + 浮动 label + 表单切换过渡 + 错误抖动 + 成功打勾
import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../contracts/auth";
import { apiFetch, setToken } from "../api/client";

type Mode = "login" | "register";

type Particle = { x: number; y: number; r: number; vy: number; vx: number; a: number; c: string };

function seedParticles(w: number, h: number): Particle[] {
  const colors = ["rgba(166,124,46,", "rgba(176,58,46,", "rgba(214,196,150,"];
  const count = Math.min(90, Math.floor((w * h) / 16000));
  return Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    r: 0.6 + Math.random() * 1.8,
    vy: 0.15 + Math.random() * 0.5,
    vx: (Math.random() - 0.5) * 0.2,
    a: 0.15 + Math.random() * 0.5,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
}

export default function AuthPage({ onAuthed, initialMode = "login" }: { onAuthed: (u: AuthUser) => void; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false); // 成功后打勾动画过渡
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: -9999, y: -9999 });

  // 墨点粒子背景（requestAnimationFrame；卸载时清理）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const resize = () => {
      canvas.width = canvas.offsetWidth * devicePixelRatio;
      canvas.height = canvas.offsetHeight * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };
    resize();
    const onResize = () => { resize(); particles = seedParticles(canvas.width / devicePixelRatio, canvas.height / devicePixelRatio); };
    window.addEventListener("resize", onResize);
    let particles = seedParticles(canvas.offsetWidth, canvas.offsetHeight);
    let t = 0;
    const tick = () => {
      t += 1;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.y -= p.vy;
        p.x += p.vx + Math.sin((t / 90) + p.y * 0.02) * 0.12;
        // 鼠标轻微斥力
        const dx = p.x - mouse.current.x;
        const dy = p.y - mouse.current.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 14400) {
          const d = Math.sqrt(d2) || 1;
          p.x += (dx / d) * 0.6;
          p.y += (dy / d) * 0.6;
        }
        if (p.y < -6) { p.y = h + 6; p.x = Math.random() * w; }
        if (p.x < -6) p.x = w + 6;
        if (p.x > w + 6) p.x = -6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.c + p.a + ")";
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onMove = (e: MouseEvent) => { mouse.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener("mousemove", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setError("");
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!username.trim() || !password) { setError("请输入用户名和密码"); return; }
    if (mode === "register") {
      if (password !== confirm) { setError("两次输入的密码不一致"); return; }
      if (nickname && nickname.length > 20) { setError("昵称最多 20 字"); return; }
    }
    setBusy(true);
    try {
      const res = await apiFetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        auth: false, // 登录/注册接口自身：不附加旧 token
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { username, password } : { username, password, displayName: nickname }),
      });
      const data = (await res.json()) as { user?: AuthUser; token?: string; error?: string };
      if (!res.ok || !data.user) { setError(data.error ?? "操作失败，请重试"); return; }
      // 业务凭证：响应体 token 存 localStorage（后续 API 走 Authorization header，不依赖 cookie）
      if (data.token) setToken(data.token);
      setOk(true);
      // 打勾动画后进入首页
      window.setTimeout(() => onAuthed(data.user!), 700);
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  const brand = (
    <div className="auth-brand">
      <div className="auth-seal" aria-hidden="true">墨 枢</div>
    </div>
  );

  return (
    <div className="auth-shell">
      <div className="auth-glow" aria-hidden="true" />
      <canvas ref={canvasRef} className="auth-particles" aria-hidden="true" />
      <div className="auth-card" key={mode}>
        {brand}
        <div className="auth-tabs" role="tablist">
          <button type="button" className={`auth-tab${mode === "login" ? " active" : ""}`} onClick={() => switchMode("login")}>登 录</button>
          <button type="button" className={`auth-tab${mode === "register" ? " active" : ""}`} onClick={() => switchMode("register")}>注 册</button>
          <span className={`auth-tab-ink${mode === "login" ? " left" : " right"}`} aria-hidden="true" />
        </div>

        <form className="auth-form" onSubmit={submit} noValidate>
          {mode === "register" && (
            <div className="auth-field">
              <input id="auth-nick" type="text" placeholder=" " value={nickname} onChange={(e) => setNickname(e.target.value)} autoComplete="nickname" />
              <label htmlFor="auth-nick">昵称（可选）</label>
            </div>
          )}
          <div className="auth-field">
            <input id="auth-user" type="text" placeholder=" " value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
            <label htmlFor="auth-user">用户名</label>
          </div>
          <div className="auth-field">
            <input id="auth-pass" type="password" placeholder=" " value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            <label htmlFor="auth-pass">密码</label>
          </div>
          {mode === "register" && (
            <div className="auth-field">
              <input id="auth-pass2" type="password" placeholder=" " value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              <label htmlFor="auth-pass2">确认密码</label>
            </div>
          )}

          <div className={`auth-error${error ? " show" : ""}`} role="alert">
            {error && <span className="auth-error-text">{error}</span>}
          </div>

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? (
              <span className="auth-spinner" aria-hidden="true" />
            ) : ok ? (
              <svg className="auth-ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            ) : (
              mode === "login" ? "确 认" : "创建账号"
            )}
          </button>
        </form>
        <p className="auth-foot">书山有路 · 墨海无涯</p>
      </div>
    </div>
  );
}
