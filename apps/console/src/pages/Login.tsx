import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";
import { useAuth } from "../lib/auth";

export function Login() {
  const { isAuthenticated, isLoading } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "forgot-sent">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    if (isAuthenticated) nav("/", { replace: true });
  }, [isAuthenticated]);

  useEffect(() => {
    fetch("/auth-info")
      .then((r) => r.json())
      .then((data: { providers: string[] }) => {
        if (data.providers?.includes("google")) setGoogleEnabled(true);
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (mode === "signup") {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name: name || email.split("@")[0],
        });
        if (error) throw new Error(error.message);
        nav("/", { replace: true });
      } else if (mode === "forgot") {
        const { error } = await authClient.forgetPassword({
          email,
          redirectTo: "/login?reset=true",
        });
        if (error) throw new Error(error.message);
        setMode("forgot-sent");
      } else {
        const { error } = await authClient.signIn.email({
          email,
          password,
        });
        if (error) throw new Error(error.message);
        nav("/", { replace: true });
      }
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  // Handle reset password callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token && params.get("reset") === "true") {
      const newPassword = prompt("Enter your new password (min 8 characters):");
      if (newPassword && newPassword.length >= 8) {
        authClient
          .resetPassword({ newPassword, token })
          .then(({ error }) => {
            if (error) {
              setError(error.message || "Failed to reset password");
            } else {
              setError("");
              setMode("login");
              alert("Password reset successfully. Please sign in.");
            }
          });
      }
      // Clean URL
      window.history.replaceState({}, "", "/login");
    }
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-fg-subtle text-sm">Loading...</div>
      </div>
    );
  }

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2.5 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  // Forgot password sent confirmation
  if (mode === "forgot-sent") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg p-4">
        <div className="w-full max-w-sm space-y-6 text-center">
          <img src="/logo.svg" alt="openma" className="h-10 mx-auto" />
          <h1 className="font-display text-xl font-semibold text-fg">Check your email</h1>
          <p className="text-sm text-fg-muted">
            If an account exists for <strong>{email}</strong>, we've sent a password reset link.
          </p>
          <button
            onClick={() => { setMode("login"); setError(""); }}
            className="text-sm text-brand hover:underline"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Header */}
        <div className="text-center">
          <img src="/logo.svg" alt="openma" className="h-10 mx-auto" />
          <h1 className="font-display text-xl font-semibold text-fg mt-4">
            {mode === "login" && "Welcome back"}
            {mode === "signup" && "Create your account"}
            {mode === "forgot" && "Reset password"}
          </h1>
          <p className="text-sm text-fg-muted mt-1">
            {mode === "login" && "Sign in to your workspace"}
            {mode === "signup" && "Get started with openma"}
            {mode === "forgot" && "Enter your email to receive a reset link"}
          </p>
        </div>

        {/* Google (only on login/signup) */}
        {googleEnabled && mode !== "forgot" && (
          <>
            <button
              onClick={handleGoogle}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-border rounded-md text-sm text-fg hover:bg-bg-surface transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-fg-subtle">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          </>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {mode === "signup" && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder="Your name"
              />
            </div>
          )}

          <div>
            <label className="text-sm text-fg-muted block mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              placeholder="you@example.com"
              required
              autoFocus
            />
          </div>

          {mode !== "forgot" && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm text-fg-muted">Password</label>
                {mode === "login" && (
                  <button
                    type="button"
                    onClick={() => { setMode("forgot"); setError(""); }}
                    className="text-xs text-brand hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                placeholder="Min 8 characters"
                required
                minLength={8}
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || (mode !== "forgot" && !password)}
            className="w-full px-4 py-2.5 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
          >
            {loading
              ? "Loading..."
              : mode === "login"
                ? "Sign in"
                : mode === "signup"
                  ? "Create account"
                  : "Send reset link"}
          </button>
        </form>

        {/* Toggle */}
        <p className="text-sm text-fg-muted text-center">
          {mode === "login" && (
            <>
              Don't have an account?{" "}
              <button onClick={() => { setMode("signup"); setError(""); }} className="text-brand hover:underline">
                Sign up
              </button>
            </>
          )}
          {mode === "signup" && (
            <>
              Already have an account?{" "}
              <button onClick={() => { setMode("login"); setError(""); }} className="text-brand hover:underline">
                Sign in
              </button>
            </>
          )}
          {mode === "forgot" && (
            <>
              Remember your password?{" "}
              <button onClick={() => { setMode("login"); setError(""); }} className="text-brand hover:underline">
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
