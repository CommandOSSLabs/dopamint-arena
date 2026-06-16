import { useCallback, useContext, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AuthenticationContextProps, UserProps } from "@/types/Authentication";
import { createContext } from "react";
import { ChildrenProps } from "@/types/ChildrenProps";
import { isFollowingUserPropsSchema } from "@/helpers/isFollowingUserPropsSchema";

export const anonymousUser: UserProps = {
  firstName: "",
  lastName: "",
  role: "anonymous",
  email: "",
  picture: "",
};

export const useAuthentication = () => {
  const context = useContext(AuthenticationContext);
  return context;
};

export const AuthenticationContext = createContext<AuthenticationContextProps>({
  user: anonymousUser,
  isLoading: false,
  setIsLoading: () => {},
  handleLoginAs: () => {},
  handleLogout: () => {},
});

export const AuthenticationProvider = ({ children }: ChildrenProps) => {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [user, setUser] = useState<UserProps>(anonymousUser);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const handleLoginAs = useCallback(
    (newUser: UserProps) => {
      setUser(newUser);
      sessionStorage.setItem("user", JSON.stringify(newUser));
      sessionStorage.setItem("userRole", newUser.role);
      if (pathname === "/" || pathname === "/auth") {
        if (newUser.role === "player") {
          navigate("/");
        } else if (newUser.role === "anonymous" || !newUser.role) {
          navigate("/");
        } else {
          navigate(`/${newUser.role}`);
        }
      }
    },
    [navigate, pathname]
  );

  useEffect(() => {
    const initialUser = sessionStorage.getItem("user");
    if (initialUser) {
      const parsedUser = JSON.parse(initialUser);
      if (!isFollowingUserPropsSchema(parsedUser)) {
        setUser(anonymousUser);
        sessionStorage.removeItem("user");
        sessionStorage.removeItem("userRole");
        setUser(anonymousUser);
        navigate("/");
      } else {
        handleLoginAs(parsedUser);
      }
    } else {
      setUser(anonymousUser);
    }
    setIsLoading(false);
  }, [handleLoginAs, navigate]);

  const handleLogout = () => {
    setUser(anonymousUser);
    sessionStorage.removeItem("user");
    sessionStorage.removeItem("userRole");
    navigate("/");
  };

  return (
    <AuthenticationContext.Provider
      value={{
        user,
        isLoading,
        setIsLoading,
        handleLoginAs,
        handleLogout,
      }}
    >
      {children}
    </AuthenticationContext.Provider>
  );
};
