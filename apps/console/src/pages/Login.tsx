import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Turnstile } from "../components/Turnstile";
import { setActiveTenantId } from "../lib/api";

// Clear browser-cached tenant pin on every successful auth transition.
// The pin is per-user — different login → different membership set →
// the previous user's tenant id is at best meaningless and at worst
// triggers "Not a member" 403s on every subsequent request.
// TenantSwitcher repopulates from /v1/me/tenants on next page load.
function onLoginSuccess(redirect: () => void) {
  setActiveTenantId(null);
  redirect();
}

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
  // Turnstile site key (public) is fetched from /auth-info; null when the
  // backend hasn't been configured yet, in which case the auth middleware
  // also soft-passes — both sides agree to skip the check.
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  // Bumping this counter re-mounts the Turnstile widget after each form
  // submission so the next attempt gets a fresh single-use token.
  const [turnstileNonce, setTurnstileNonce] = useState(0);
  const otpRef = useRef<HTMLInputElement>(null);

  // Honor `?next=` so callers (e.g. /cli/login) can bounce through here and
  // land back where they started after sign-in. Restricted to same-origin
  // paths so a malicious link can't trick the user into redirecting offsite.
  const nextUrl = (() => {
    const raw = new URLSearchParams(window.location.search).get("next");
    if (!raw) return "/";
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
    return "/";
  })();

  // Auto-redirect when an already-authenticated user lands on /login (e.g.
  // a stale tab, or someone hitting /login?next=... with an existing
  // session). Each mode handler below ALSO calls nav(nextUrl) on success;
  // this effect only fires when `isAuthenticated` was already true at
  // mount or flips true via session refresh independent of a handler.
  //
  // Subtlety: we don't call onLoginSuccess() here because that resets
  // active tenant — fine when the user just signed in (membership may
  // have changed) but unwanted when they're just being bounced through
  // /login with an existing session. We also wait for !isLoading so we
  // don't fire while Better Auth's useSession is still pending its first
  // result and isAuthenticated reads spuriously false. The bug this
  // guards against: signup OTP verify completed → session updates →
  // isAuthenticated flips true → effect previously called onLoginSuccess
  // which reset tenant THEN nav'd, racing the handler's own nav and
  // sometimes landing on / instead of /connect-runtime.
  useEffect(() => {
    if (!isLoading && isAuthenticated && nextUrl !== "/") {
      nav(nextUrl, { replace: true });
    }
  }, [isAuthenticated, isLoading]);

  // Whether the backend gates sign-up behind an email-OTP verification.
  // /auth-info advertises "email-otp" iff AUTH_REQUIRE_EMAIL_VERIFY=1 on
  // the server. When absent (default self-host), the sign-up flow does
  // NOT route through verify-signup — sign-up succeeds → session cookie
  // → straight to /. Avoids stranding the user on a verify screen with
  // no way to receive the code.
  const [emailVerifyRequired, setEmailVerifyRequired] = useState(false);

  useEffect(() => {
    fetch("/auth-info")
      .then((r) => r.json())
      .then((data: { providers: string[]; turnstile_site_key?: string | null }) => {
        if (data.providers?.includes("google")) setGoogleEnabled(true);
        if (data.providers?.includes("email-otp")) setEmailVerifyRequired(true);
        setTurnstileSiteKey(data.turnstile_site_key ?? null);
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

  // Modes that trigger an outbound email — those need a Turnstile token.
  // Verify modes (verify-signup, verify-login) submit OTP and don't send
  // mail, so they don't need the widget.
  const isEmailSendMode =
    mode === "signup" ||
    mode === "login" ||
    mode === "otp-login" ||
    mode === "forgot";

  // Submit can fire before Turnstile has minted a token (user clicks fast,
  // cold script load, etc.). Rather than disabling the button — which
  // makes the form feel "not ready" — we let the click through and await
  // the token via a queue. The widget's onToken callback drains all
  // pending resolvers, then submit proceeds with the real request.
  const tokenRef = useRef("");
  const pendingTokenResolvers = useRef<Array<(t: string) => void>>([]);
  const handleTurnstileToken = (t: string) => {
    tokenRef.current = t;
    setTurnstileToken(t);
    const queued = pendingTokenResolvers.current;
    pendingTokenResolvers.current = [];
    for (const resolve of queued) resolve(t);
  };
  const waitForTurnstileToken = (): Promise<string> => {
    if (!turnstileSiteKey) return Promise.resolve(""); // soft-pass when unconfigured
    if (tokenRef.current) return Promise.resolve(tokenRef.current);
    // 30s ceiling so a stuck widget doesn't hang the form forever.
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTokenResolvers.current = pendingTokenResolvers.current.filter((r) => r !== wrapped);
        reject(new Error("Bot challenge timed out — refresh the page and try again"));
      }, 30_000);
      const wrapped = (t: string) => {
        clearTimeout(timer);
        resolve(t);
      };
      pendingTokenResolvers.current.push(wrapped);
    });
  };
  const resetTurnstile = () => {
    tokenRef.current = "";
    setTurnstileToken("");
    setTurnstileNonce((n) => n + 1);
  };

  /** Build fetchOptions with the Turnstile token (await if it hasn't
   *  arrived yet). Returns undefined when Turnstile isn't configured at
   *  all — middleware soft-passes in that case. */
  const buildTurnstileOpts = async () => {
    if (!turnstileSiteKey) return undefined;
    const token = await waitForTurnstileToken();
    return { headers: { "cf-turnstile-token": token } };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Block on Turnstile up front for email-send modes so any subsequent
      // authClient call already has the header. The user just sees the
      // submit button spin — they don't see a separate "verifying" state.
      const turnstileFetchOpts = isEmailSendMode ? await buildTurnstileOpts() : undefined;

      if (mode === "signup") {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name: name || email.split("@")[0],
          fetchOptions: turnstileFetchOpts,
        });
        if (error) throw new Error(error.message);
        clearOtp();
        if (emailVerifyRequired) {
          // OTP gate enabled — show verify screen, OTP delivered via
          // operator's sendVerificationOTP wiring.
          setMode("verify-signup");
        } else {
          // Default self-host (no SMTP) — better-auth already created a
          // session cookie at sign-up. Either we already see it via
          // useAuth (the redirect effect at the top fires), or the
          // session writes briefly raced; explicit signIn.email is the
          // belt-and-braces path that always lands the cookie.
          await authClient.signIn.email({ email, password });
          onLoginSuccess(() => nav(nextUrl, { replace: true }));
        }
      } else if (mode === "login") {
        const { error } = await authClient.signIn.email({
          email,
          password,
          fetchOptions: turnstileFetchOpts,
        });
        if (error) {
          if (
            error.message?.toLowerCase().includes("verify") ||
            error.message?.toLowerCase().includes("verification")
          ) {
            // Need a fresh token — the previous one was consumed by signIn.email.
            const reSendOpts = await buildTurnstileOpts();
            await authClient.emailOtp.sendVerificationOtp({
              email,
              type: "email-verification",
              fetchOptions: reSendOpts,
            });
            clearOtp();
            setMode("verify-signup");
          } else {
            throw new Error(error.message);
          }
        } else {
          onLoginSuccess(() => nav(nextUrl, { replace: true }));
        }
      } else if (mode === "otp-login") {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "sign-in",
          fetchOptions: turnstileFetchOpts,
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
        onLoginSuccess(() => nav(nextUrl, { replace: true }));
      } else if (mode === "verify-login") {
        const signInOtp = authClient.signIn.emailOtp as any;
        const { data, error } = await signInOtp({ email, otp });
        if (error) throw new Error(error.message);
        if (data) onLoginSuccess(() => nav(nextUrl, { replace: true }));
      } else if (mode === "forgot") {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "forget-password",
          fetchOptions: turnstileFetchOpts,
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
      // Always reset the Turnstile token after a submit attempt — tokens
      // are single-use, so we'd 401 on the next try otherwise.
      if (isEmailSendMode) resetTurnstile();
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
      const opts = await buildTurnstileOpts();
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: typeMap[mode] || "email-verification",
        fetchOptions: opts,
      });
      if (error) throw new Error(error.message);
      clearOtp();
    } catch (err: any) {
      setError(err.message || "Failed to resend code");
    } finally {
      resetTurnstile();
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: nextUrl,
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

          {/* Turnstile bot challenge — only on email-send modes. When the
              backend hasn't been configured (turnstileSiteKey === null),
              widget renders nothing and the submit button doesn't gate on
              the token (matches the soft-pass middleware behavior).

              Widget is rendered hidden so it loads + runs the challenge
              in the background while the user fills in the form. The
              submit button stays clickable; if the token isn't ready
              yet, handleSubmit awaits it and the user just sees the
              normal Loading state. */}
          {isEmailSendMode && turnstileSiteKey && (
            <div className="hidden" aria-hidden="true">
              <Turnstile
                key={turnstileNonce}
                siteKey={turnstileSiteKey}
                onToken={handleTurnstileToken}
                onExpire={resetTurnstile}
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
