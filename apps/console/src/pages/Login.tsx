import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";

type Mode =
  | "login"
  | "signup"
  | "otp-login"
  | "verify-signup"
  | "verify-login"
  | "forgot"
  | "reset-otp";

export function Login() {
  const { isAuthenticated, isLoading } = useAuth();
  const { toast } = useToast();
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const otpRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (
      (mode === "verify-signup" || mode === "verify-login" || mode === "reset-otp") &&
      otpRef.current
    ) {
      otpRef.current.focus();
    }
  }, [mode]);

  const clearOtp = () => setOtp("");

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
        clearOtp();
        setMode("verify-signup");
      } else if (mode === "login") {
        const { error } = await authClient.signIn.email({
          email,
          password,
        });
        if (error) {
          if (
            error.message?.toLowerCase().includes("verify") ||
            error.message?.toLowerCase().includes("verification")
          ) {
            await authClient.emailOtp.sendVerificationOtp({
              email,
              type: "email-verification",
            });
            clearOtp();
            setMode("verify-signup");
          } else {
            throw new Error(error.message);
          }
        } else {
          nav("/", { replace: true });
        }
      } else if (mode === "otp-login") {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "sign-in",
        });
        if (error) throw new Error(error.message);
        clearOtp();
        setMode("verify-login");
      } else if (mode === "verify-signup") {
        const { error } = await authClient.emailOtp.verifyEmail({
          email,
          otp,
        });
        if (error) throw new Error(error.message);
        nav("/", { replace: true });
      } else if (mode === "verify-login") {
        const signInOtp = authClient.signIn.emailOtp as any;
        const { data, error } = await signInOtp({ email, otp });
        if (error) throw new Error(error.message);
        if (data) nav("/", { replace: true });
      } else if (mode === "forgot") {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "forget-password",
        });
        if (error) throw new Error(error.message);
        clearOtp();
        setPassword("");
        setMode("reset-otp");
      } else if (mode === "reset-otp") {
        const res = await fetch("/auth/email-otp/reset-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, otp, password }),
        });
        const data = await res.json() as any;
        if (!res.ok) throw new Error(data?.message || "Failed to reset password");
        setError("");
        setMode("login");
        toast("Password reset successfully. Please sign in.", "success");
      }
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setLoading(true);
    try {
      const typeMap: Record<string, "sign-in" | "email-verification" | "forget-password"> = {
        "verify-signup": "email-verification",
        "verify-login": "sign-in",
        "reset-otp": "forget-password",
      };
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: typeMap[mode] || "email-verification",
      });
      if (error) throw new Error(error.message);
      clearOtp();
    } catch (err: any) {
      setError(err.message || "Failed to resend code");
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

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-fg-subtle text-sm">Loading...</div>
      </div>
    );
  }

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2.5 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  const isOtpMode = mode === "verify-signup" || mode === "verify-login" || mode === "reset-otp";

  const titles: Record<Mode, string> = {
    login: "Welcome back",
    signup: "Create your account",
    "otp-login": "Sign in with email code",
    "verify-signup": "Verify your email",
    "verify-login": "Enter your code",
    forgot: "Reset password",
    "reset-otp": "Reset your password",
  };

  const subtitles: Record<Mode, string> = {
    login: "Sign in to your workspace",
    signup: "Get started with openma",
    "otp-login": "We'll send a 6-digit code to your email",
    "verify-signup": `We sent a code to ${email}`,
    "verify-login": `We sent a code to ${email}`,
    forgot: "We'll send a code to reset your password",
    "reset-otp": `Enter the code sent to ${email}`,
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Header */}
        <div className="text-center">
          <img src="/logo.svg" alt="openma" className="h-10 mx-auto" />
          <h1 className="font-display text-xl font-semibold text-fg mt-4">
            {titles[mode]}
          </h1>
          <p className="text-sm text-fg-muted mt-1">{subtitles[mode]}</p>
        </div>

        {/* Google (only on login/signup/otp-login) */}
        {googleEnabled &&
          (mode === "login" || mode === "signup" || mode === "otp-login") && (
            <>
              <button
                onClick={handleGoogle}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-border rounded-md text-sm text-fg hover:bg-bg-surface transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
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

          {/* Name — signup only */}
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

          {/* Email — non-OTP modes */}
          {!isOtpMode && (
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
          )}

          {/* Password — login / signup */}
          {(mode === "login" || mode === "signup") && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm text-fg-muted">Password</label>
                {mode === "login" && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("forgot");
                      setError("");
                    }}
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

          {/* OTP input */}
          {isOtpMode && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">
                Verification code
              </label>
              <input
                ref={otpRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                className={`${inputCls} text-center text-2xl tracking-[0.5em] font-mono`}
                placeholder="000000"
                required
                autoComplete="one-time-code"
              />
            </div>
          )}

          {/* New password — reset-otp */}
          {mode === "reset-otp" && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">
                New password
              </label>
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

          {/* Submit */}
          <button
            type="submit"
            disabled={
              loading ||
              (!isOtpMode && !email) ||
              (isOtpMode && otp.length < 6) ||
              ((mode === "login" || mode === "signup") && !password) ||
              (mode === "reset-otp" && !password)
            }
            className="w-full px-4 py-2.5 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
          >
            {loading
              ? "Loading..."
              : mode === "login"
                ? "Sign in"
                : mode === "signup"
                  ? "Create account"
                  : mode === "otp-login"
                    ? "Send code"
                    : mode === "forgot"
                      ? "Send reset code"
                      : mode === "reset-otp"
                        ? "Reset password"
                        : "Verify"}
          </button>
        </form>

        {/* Resend for OTP modes */}
        {isOtpMode && (
          <p className="text-sm text-fg-muted text-center">
            Didn't receive the code?{" "}
            <button
              onClick={handleResend}
              disabled={loading}
              className="text-brand hover:underline disabled:opacity-50"
            >
              Resend
            </button>
          </p>
        )}

        {/* Mode switchers */}
        <p className="text-sm text-fg-muted text-center">
          {mode === "login" && (
            <>
              <button
                onClick={() => {
                  setMode("otp-login");
                  setError("");
                }}
                className="text-brand hover:underline"
              >
                Sign in with email code
              </button>
              <span className="mx-2">&middot;</span>
              <button
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
                className="text-brand hover:underline"
              >
                Sign up
              </button>
            </>
          )}
          {mode === "signup" && (
            <>
              Already have an account?{" "}
              <button
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className="text-brand hover:underline"
              >
                Sign in
              </button>
            </>
          )}
          {mode === "otp-login" && (
            <>
              <button
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className="text-brand hover:underline"
              >
                Sign in with password
              </button>
              <span className="mx-2">&middot;</span>
              <button
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
                className="text-brand hover:underline"
              >
                Sign up
              </button>
            </>
          )}
          {(mode === "verify-signup" || mode === "verify-login") && (
            <button
              onClick={() => {
                setMode(mode === "verify-signup" ? "signup" : "otp-login");
                setError("");
                clearOtp();
              }}
              className="text-brand hover:underline"
            >
              Go back
            </button>
          )}
          {mode === "forgot" && (
            <>
              Remember your password?{" "}
              <button
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className="text-brand hover:underline"
              >
                Sign in
              </button>
            </>
          )}
          {mode === "reset-otp" && (
            <button
              onClick={() => {
                setMode("forgot");
                setError("");
                clearOtp();
              }}
              className="text-brand hover:underline"
            >
              Go back
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
