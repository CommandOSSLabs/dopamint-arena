import { Outlet } from "react-router-dom";
import { useAuthentication } from "@/contexts/Authentication";
import { PageLoader } from "@/components/general/PageLoader";

export default function PlayerPocLayout() {
  const { user, isLoading } = useAuthentication();

  if (isLoading) {
    return <PageLoader theme="lobby" message="Loading POC..." />;
  }

  // if (user?.role !== "player") {
  //   return "Not allowed";
  // }

  return <Outlet />;
}
