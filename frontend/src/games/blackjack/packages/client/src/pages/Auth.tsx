import { useAuthentication } from "@/contexts/Authentication";
import { useEffect } from "react";
import { jwtDecode } from "jwt-decode";
import { PageLoader } from "@/components/general/PageLoader";
import { UserRole } from "@/types/Authentication";
import { useAuthCallback } from "@mysten/enoki/react";
import { useCustomWallet } from "@/contexts/CustomWallet";

export default function Auth() {
  const { handleLoginAs, setIsLoading } = useAuthentication();
  const { handled } = useAuthCallback();
  const { jwt } = useCustomWallet();

  useEffect(() => {
    setIsLoading(!handled);
  }, [handled, setIsLoading]);

  useEffect(() => {
    if (!!jwt) {
      const decodedJwt: any = jwtDecode(jwt);
      handleLoginAs({
        firstName: decodedJwt["given_name"],
        lastName: decodedJwt["family_name"],
        role: sessionStorage.getItem("userRole") as UserRole,
        email: decodedJwt["email"],
        picture: decodedJwt["picture"],
      });
    }
  }, [jwt, handleLoginAs]);

  return <PageLoader theme="lobby" message="Logging in to casino..." />;
}
