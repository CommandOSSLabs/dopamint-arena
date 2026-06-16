import { Outlet } from "react-router-dom";
import { useAuthentication } from "@/contexts/Authentication";
import { PageLoader } from "@/components/general/PageLoader";

export default function PlayerGameLayout() {
  const { user, isLoading } = useAuthentication();

  if (isLoading) {
    return <PageLoader theme="game" message="Authenticating player..." />;
  }

  // if (user?.role !== "player") {
  //   return "Not allowed";
  // }

  return <Outlet />;
}
