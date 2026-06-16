import { Outlet } from "react-router-dom";
import { useAuthentication } from "@/contexts/Authentication";
import { PageLoader } from "@/components/general/PageLoader";
import { useCustomWallet } from "@/contexts/CustomWallet";

export default function DealerLayout() {
  const { user, isLoading } = useAuthentication();
  const { address } = useCustomWallet();

  if (isLoading || !address) {
    return <PageLoader theme="lobby" message="Loading dealer profile..." />;
  }

  // if (user?.role !== "dealer") {
  //   return "Not allowed";
  // }

  return <Outlet />;
}
