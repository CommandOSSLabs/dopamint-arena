import { Outlet } from "react-router-dom";
import { useAuthentication } from "@/contexts/Authentication";
import { PageLoader } from "@/components/general/PageLoader";

export default function AdminLayout() {
  const { user, isLoading } = useAuthentication();

  if (isLoading) {
    return <PageLoader theme="lobby" message="Loading admin session..." />;
  }

  if (user?.role !== "admin") {
    return <>Not allowed</>;
  }

  return <Outlet />;
}
