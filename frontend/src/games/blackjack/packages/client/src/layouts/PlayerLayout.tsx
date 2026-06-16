import { Outlet, Navigate } from "react-router-dom";
import { useAuthentication } from "@/contexts/Authentication";
import { PageLoader } from "@/components/general/PageLoader";

export default function PlayerLayout() {
  const { user, isLoading } = useAuthentication();

  if (isLoading) {
    return <PageLoader theme="lobby" message="Authenticating..." />;
  }

  if (user?.role !== "player") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
