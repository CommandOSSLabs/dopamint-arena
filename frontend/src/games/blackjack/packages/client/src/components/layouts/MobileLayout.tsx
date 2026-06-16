import { useAuthentication } from "@/contexts/Authentication";
import React from "react";
import { AppBar } from "./navbars/Appbar";
import { ChildrenProps } from "@/types/ChildrenProps";
import { BottomNavbar } from "./navbars/BottomNavbar";
import { AppLogo } from "./navbars/AppLogo";
import { useLocation } from "react-router-dom";

export const MobileLayout = ({ children }: ChildrenProps) => {
  const { pathname } = useLocation();
  const { user } = useAuthentication();

  const isPlayerPage = pathname === "/" || pathname === "/auth" || pathname.startsWith("/player") || pathname.startsWith("/dealer");
  if (isPlayerPage) {
    const isGame = pathname === "/player/game";
    return (
      <div className={`w-screen ${isGame ? "h-screen overflow-hidden" : "min-h-screen"} bg-zinc-950 p-0 m-0`}>
        {children}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col w-full min-h-screen relative role-${user.role}`}
    >
      <div className="flex-1 flex flex-col space-y-2 flex-1">
        <AppBar
          showBurger={false}
          onBurgerClick={() => {}}
          headerElement={<AppLogo className="!text-black" />}
        />
        <div className="p-2 ">{children}</div>
      </div>
      <BottomNavbar />
    </div>
  );
};
