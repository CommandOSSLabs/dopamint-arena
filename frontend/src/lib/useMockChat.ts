import { useEffect, useRef, useState } from "react";

export interface ChatMessage {
  id: number;
  user: string;
  color: string;
  text: string;
  me?: boolean;
}

const USERS = [
  { user: "satoshi.sui", color: "#16a37b" },
  { user: "neon_whale", color: "#8b5cf6" },
  { user: "degenDan", color: "#ef5a72" },
  { user: "0xLuna", color: "#2e8fe0" },
  { user: "mintmaxi", color: "#d99a00" },
];

const LINES = [
  "gm gm ☀️",
  "that coinflip streak is unreal",
  "who's up on blackjack rn",
  "+420 on slots lol",
  "tunnel settled in <1s 🔥",
  "demo wallet works clean",
  "rugged on dice again 😭",
  "quantum poker is wild",
  "tps going brrr",
  "lfg 🚀",
  "wen leaderboard reset",
];

const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

function seed(): ChatMessage[] {
  return [
    { id: 1, user: "neon_whale", color: "#8b5cf6", text: "gm degens" },
    {
      id: 2,
      user: "0xLuna",
      color: "#2e8fe0",
      text: "blackjack bot is cooking today",
    },
    { id: 3, user: "mintmaxi", color: "#d99a00", text: "+$120 last hour 😎" },
  ];
}

export interface MockChat {
  messages: ChatMessage[];
  send: (text: string) => void;
}

/** Demo community chat: bots post on an interval; `send` appends your message. */
export function useMockChat(): MockChat {
  const [messages, setMessages] = useState<ChatMessage[]>(seed);
  const nextId = useRef(100);

  useEffect(() => {
    const id = setInterval(
      () => {
        const u = pick(USERS);
        setMessages((m) =>
          [
            ...m,
            {
              id: nextId.current++,
              user: u.user,
              color: u.color,
              text: pick(LINES),
            },
          ].slice(-40),
        );
      },
      2600 + Math.random() * 2200,
    );
    return () => clearInterval(id);
  }, []);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((m) =>
      [
        ...m,
        {
          id: nextId.current++,
          user: "you",
          color: "var(--primary)",
          text: trimmed,
          me: true,
        },
      ].slice(-40),
    );
  };

  return { messages, send };
}
