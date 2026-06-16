import { USER_ROLES } from "@/constants/USER_ROLES";
import React, { useState } from "react";
import { useAuthentication } from "@/contexts/Authentication";
import { SuitSpinner } from "../general/SuitSpinner";
import { Link } from "react-router-dom";
import Image from "@/components/general/Image";
import { ConnectModal } from "@mysten/dapp-kit";
import { Button } from "../ui/button";
import { useCustomWallet } from "@/contexts/CustomWallet";

export const LoginForm = () => {
  const { redirectToAuthUrl } = useCustomWallet();
  const { user, isLoading: isAuthLoading } = useAuthentication();
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);

  if (isAuthLoading || user.role !== USER_ROLES.ROLE_4) {
    return (
      <div className="flex justify-center items-center py-6 w-full">
        <SuitSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-6 flex flex-col items-center w-full">
      <h3 className="text-xs text-zinc-400 font-bold uppercase tracking-widest text-center border-t border-zinc-800/80 w-full pt-4">
        Play Mode (Testnet Only)
      </h3>
      <div className="flex flex-col space-y-4 items-center justify-center w-full">
        {[
          USER_ROLES.ROLE_3,
        ].map((role) => (
          <div key={role} className="space-y-3 w-full flex flex-col items-center">
            <Link
              to="#"
              onClick={() => redirectToAuthUrl(role)}
              className="flex items-center justify-center space-x-3 px-4 py-3 bg-zinc-900 border border-zinc-800 text-white w-full rounded-xl hover:bg-zinc-800 transition-all shadow-inner font-medium text-sm"
            >
              <Image src="/google.svg" alt="Google" width={18} height={18} />
              <div>Sign In with Google </div>
            </Link>
            <div className="text-zinc-500 text-[10px] uppercase font-bold tracking-widest">or</div>
            <Button
              className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 font-extrabold py-3 rounded-xl uppercase tracking-wider text-xs shadow-md gold-glow-hover border-transparent"
              onClick={() => {
                sessionStorage.setItem("userRole", role);
                setIsConnectModalOpen(true);
              }}
            >
              Connect Web3 Wallet
            </Button>
          </div>
        ))}
      </div>
      {/* we could also create a separate ConnectModal component for each user role, and pass the real button as a trigger */}
      <ConnectModal
        open={isConnectModalOpen}
        onOpenChange={(open) => {
          if (!open) setIsConnectModalOpen(false);
        }}
        trigger={<button style={{ display: "none" }} />}
      />
    </div>
  );
};
