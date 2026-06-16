import { useEffect } from "react";
import React from "react";
import { OwnedObjectsGrid } from "@/components/general/OwnedObjectsGrid";

export default function Admin() {
  useEffect(() => {
    document.title = "PoC Template for Admins";
  }, []);

  return <OwnedObjectsGrid />;
}
