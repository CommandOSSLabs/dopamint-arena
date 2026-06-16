import { useEffect } from "react";
import { Paper } from "@/components/general/Paper";
import { TransferSUIForm } from "@/components/forms/TransferSUIForm";
import React from "react";

export default function Transfer() {
  useEffect(() => {
    document.title = "Transfer SUI";
  }, []);

  return (
    <Paper>
      <TransferSUIForm />
    </Paper>
  );
}
