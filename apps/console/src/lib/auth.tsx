import { createContext, useContext, useState, type ReactNode } from "react";

interface AuthCtx {
  apiKey: string;
  setApiKey: (key: string) => void;
}

const AuthContext = createContext<AuthCtx>({ apiKey: "", setApiKey: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem("api_key") || ""
  );

  const set = (key: string) => {
    setApiKey(key);
    localStorage.setItem("api_key", key);
  };

  return (
    <AuthContext.Provider value={{ apiKey, setApiKey: set }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
