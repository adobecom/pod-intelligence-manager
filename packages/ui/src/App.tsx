import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { AuthProvider } from "./contexts/AuthContext";
import { OrgProvider } from "./contexts/OrgContext";
import { AuthGate } from "./components/AuthGate";
import { OrgGate } from "./components/OrgGate";

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <OrgProvider>
          <OrgGate>
            <RouterProvider router={router} />
          </OrgGate>
        </OrgProvider>
      </AuthGate>
    </AuthProvider>
  );
}
