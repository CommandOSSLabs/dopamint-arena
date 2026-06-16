import { USER_ROLES } from "@/constants/USER_ROLES";
import { useAuthentication } from "@/contexts/Authentication";
import Image from "@/components/general/Image";
import { Link } from "react-router-dom";

interface AppLogoProps {
  className?: string;
}
export const AppLogo = ({ className = "" }: AppLogoProps) => {
  const { user } = useAuthentication();
  return (
    <Link
      to={user.role === USER_ROLES.ROLE_4 ? "/" : `/${user.role}`}
      className={`min-w-[175px] flex space-x-3 text-2xl font-bold text-contrast items-center ${className}`}
    >
      <Image
        src={
          className.includes("text-black")
            ? "/blackjack-logo-dark.svg"
            : "/blackjack-logo-gold.svg"
        }
        alt="Blackjack Logo"
        width={40}
        height={40}
      />
      <div
        className={
          className.includes("text-black") ? "text-black" : "text-white"
        }
      >
        Blackjack
      </div>
    </Link>
  );
};
