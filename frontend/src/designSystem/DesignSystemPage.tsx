import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  Copy,
  CreditCard,
  Info,
  Loader2,
  LogOut,
  Settings,
  Sparkles,
  User,
  Wallet,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  WAL_ACCENTS,
  WAL_GRADIENTS,
  WAL_NEUTRALS,
  WAL_SEMANTIC,
  type WalSwatch,
} from "./tokens";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ShowcaseItem, ShowcaseSection } from "./ShowcaseSection";

const NAV_SECTIONS = [
  { id: "colors", label: "Colors" },
  { id: "type", label: "Type" },
  { id: "buttons", label: "Buttons" },
  { id: "badges", label: "Badges" },
  { id: "forms", label: "Forms" },
  { id: "feedback", label: "Feedback" },
  { id: "data", label: "Data" },
  { id: "overlays", label: "Overlays" },
] as const;

function Swatch({ swatch }: { swatch: WalSwatch }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="h-14 rounded-xl border border-border"
        style={{ background: swatch.value }}
      />
      <div className="text-xs font-medium text-foreground">{swatch.name}</div>
      <div className="wal-mono text-[11px] text-muted-foreground">
        {swatch.note}
      </div>
    </div>
  );
}

export function DesignSystemPage() {
  const [settlePct, setSettlePct] = useState(64);
  const [autoPlay, setAutoPlay] = useState(true);

  return (
    <div className="relative min-h-full text-foreground">
      <div className="wal-aurora" aria-hidden />

      <div className="relative z-[1]">
        <header className="sticky top-0 z-20 border-b border-border bg-background/70 backdrop-blur-xl">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
            <div className="flex items-center gap-3">
              <Link
                to="/"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-4" />
                Arena
              </Link>
              <Separator orientation="vertical" className="h-4" />
              <span className="wal-display text-sm text-foreground">
                mtps <span className="wal-gradient-text">design</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <nav className="hidden items-center gap-1 lg:flex">
                {NAV_SECTIONS.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="wal-mono rounded-full px-2.5 py-1 text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {section.label}
                  </a>
                ))}
              </nav>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="mx-auto flex max-w-5xl flex-col gap-14 px-6 py-12">
          {/* Hero */}
          <section>
            <p className="wal-eyebrow">Component Library</p>
            <h1 className="wal-display mt-3 text-5xl text-foreground md:text-6xl">
              mtps, the{" "}
              <span className="wal-gradient-text">walrus&nbsp;memory</span> way.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
              shadcn/ui primitives re-themed to the Walrus Memory design
              language — deep ink canvas, holographic accents, pill actions.
              Flip the toggle to preview light and dark.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button>
                Build on Walrus <ArrowRight />
              </Button>
              <span className="wal-mono inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">
                <Sparkles
                  className="size-3.5"
                  style={{ color: "var(--wal-lilac)" }}
                />
                64 design tokens
              </span>
            </div>
          </section>

          <ShowcaseSection
            id="colors"
            eyebrow="Foundation"
            title="Colors & tokens"
            description="The ink/cream canvas, holographic accents, and signature gradients — plus the shadcn semantic tokens mapped onto them. Swatches reflect the active theme."
          >
            <div className="flex flex-col gap-7">
              <div>
                <p className="wal-mono mb-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Neutrals
                </p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  {WAL_NEUTRALS.map((swatch) => (
                    <Swatch key={swatch.name} swatch={swatch} />
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <p className="wal-mono mb-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Accents
                </p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  {WAL_ACCENTS.map((swatch) => (
                    <Swatch key={swatch.name} swatch={swatch} />
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <p className="wal-mono mb-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Gradients
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {WAL_GRADIENTS.map((swatch) => (
                    <div key={swatch.name} className="flex flex-col gap-1.5">
                      <div
                        className="h-16 rounded-xl border border-border"
                        style={{ background: swatch.value }}
                      />
                      <div className="text-xs font-medium text-foreground">
                        {swatch.name}
                      </div>
                      <div className="wal-mono text-[11px] text-muted-foreground">
                        {swatch.note}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <p className="wal-mono mb-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Semantic tokens
                </p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
                  {WAL_SEMANTIC.map((swatch) => (
                    <Swatch key={swatch.name} swatch={swatch} />
                  ))}
                </div>
              </div>
            </div>
          </ShowcaseSection>

          <ShowcaseSection
            id="type"
            eyebrow="Foundation"
            title="Typography"
            description="Outfit display at weight 500 with very tight leading; JetBrains Mono for eyebrows, labels, and on-chain values."
          >
            <div className="flex flex-col gap-4">
              <div className="wal-display text-6xl text-foreground">
                walrus<span className="wal-gradient-text">memory.</span>
              </div>
              <h2 className="wal-display text-4xl text-foreground">
                Settlement
              </h2>
              <h3 className="wal-display text-2xl text-foreground">
                Tunnel state
              </h3>
              <p className="text-lg leading-relaxed text-foreground">
                Body — off-chain updates are final the moment both parties sign.
              </p>
              <p className="text-[15px] leading-relaxed text-muted-foreground">
                Muted — captions, hints, and secondary metadata sit here.
              </p>
              <p
                className="wal-mono text-sm"
                style={{ color: "var(--wal-lilac)" }}
              >
                mono · tunnel::close_cooperative(&mut tunnel, …)
              </p>
            </div>
          </ShowcaseSection>

          <ShowcaseSection
            id="buttons"
            eyebrow="Components"
            title="Buttons"
            description="Pill-shaped actions: shadcn variants plus the brand's solid accent fills, with icons and loading states."
          >
            <div className="flex flex-col gap-6">
              <ShowcaseItem label="Variants">
                <Button>Open tunnel</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">Force close</Button>
                <Button variant="link">Link</Button>
              </ShowcaseItem>
              <ShowcaseItem label="Brand fills">
                <Button className="bg-[#CAB1FF] text-[#0C0F1D] hover:bg-[#b79bff]">
                  Learn about WAL
                </Button>
                <Button className="bg-[#9CEFCF] text-[#0C0F1D] hover:bg-[#5fd9ad]">
                  Connect agent
                </Button>
                <Button>
                  Build on Walrus <ArrowRight />
                </Button>
              </ShowcaseItem>
              <ShowcaseItem label="Sizes & states">
                <Button size="sm">Small</Button>
                <Button>Default</Button>
                <Button size="lg">Large</Button>
                <Button size="icon" aria-label="Settings">
                  <Settings />
                </Button>
                <Button variant="outline">
                  <Wallet /> Deposit
                </Button>
                <Button disabled>
                  <Loader2 className="animate-spin" /> Settling…
                </Button>
              </ShowcaseItem>
            </div>
          </ShowcaseSection>

          <ShowcaseSection
            id="badges"
            eyebrow="Components"
            title="Badges"
            description="Pill status markers for tunnels, transactions, and live signals."
          >
            <ShowcaseItem label="Variants">
              <Badge>Active</Badge>
              <Badge variant="secondary">Pending</Badge>
              <Badge variant="destructive">Disputed</Badge>
              <Badge variant="outline">Closed</Badge>
              <Badge className="border-transparent bg-[#EAFF80] text-[#0C0F1D]">
                <Zap className="size-3" /> Live
              </Badge>
            </ShowcaseItem>
          </ShowcaseSection>

          <ShowcaseSection
            id="forms"
            eyebrow="Components"
            title="Forms & inputs"
            description="Text fields, selects, and toggles for deposits and game configuration."
          >
            <div className="grid gap-6 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ds-amount">Deposit amount</Label>
                <Input
                  id="ds-amount"
                  placeholder="0.00 SUI"
                  inputMode="decimal"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ds-game">Game</Label>
                <Select>
                  <SelectTrigger id="ds-game" className="w-full">
                    <SelectValue placeholder="Pick a game" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Self-playing</SelectLabel>
                      <SelectItem value="coinflip">Coin Flip</SelectItem>
                      <SelectItem value="dice">Dice</SelectItem>
                      <SelectItem value="blackjack">Blackjack</SelectItem>
                      <SelectItem value="quantum-poker">
                        Quantum Poker
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2 md:col-span-2">
                <Label htmlFor="ds-memo">Memo</Label>
                <Textarea
                  id="ds-memo"
                  placeholder="Optional note attached to the settlement…"
                />
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <Checkbox id="ds-terms" defaultChecked />
                  <Label htmlFor="ds-terms" className="font-normal">
                    Off-chain updates are binding
                  </Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id="ds-autoplay"
                    checked={autoPlay}
                    onCheckedChange={setAutoPlay}
                  />
                  <Label htmlFor="ds-autoplay" className="font-normal">
                    Auto-play{" "}
                    <span className="text-muted-foreground">
                      ({autoPlay ? "on" : "off"})
                    </span>
                  </Label>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ds-settle">Settle at</Label>
                  <span
                    className="wal-mono text-sm tabular-nums"
                    style={{ color: "var(--wal-lilac)" }}
                  >
                    {settlePct}%
                  </span>
                </div>
                <Slider
                  id="ds-settle"
                  value={[settlePct]}
                  max={100}
                  step={1}
                  onValueChange={(value) => setSettlePct(value[0] ?? 0)}
                />
                <Progress value={settlePct} />
              </div>
            </div>
          </ShowcaseSection>

          <ShowcaseSection
            id="feedback"
            eyebrow="Components"
            title="Feedback"
            description="Alerts, toasts, tooltips, and loading skeletons."
          >
            <div className="flex flex-col gap-6">
              <div className="grid gap-3 md:grid-cols-2">
                <Alert>
                  <Info />
                  <AlertTitle>Tunnel opened</AlertTitle>
                  <AlertDescription>
                    Both parties deposited. Off-chain play is live.
                  </AlertDescription>
                </Alert>
                <Alert variant="destructive">
                  <Info />
                  <AlertTitle>Dispute raised</AlertTitle>
                  <AlertDescription>
                    Counter with a newer signed state before the timeout.
                  </AlertDescription>
                </Alert>
              </div>
              <ShowcaseItem label="Toasts & tooltips">
                <Button
                  variant="outline"
                  onClick={() => toast.success("Settlement confirmed")}
                >
                  Success toast
                </Button>
                <Button
                  variant="outline"
                  onClick={() => toast.error("Signature rejected")}
                >
                  Error toast
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    toast("State update", {
                      description: "nonce 41 · dual-signed",
                    })
                  }
                >
                  Plain toast
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="Info">
                      <Info />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Effective off-chain TPS</TooltipContent>
                </Tooltip>
              </ShowcaseItem>
              <div className="flex flex-col gap-2">
                <span className="wal-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  Skeleton
                </span>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-full" />
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              </div>
            </div>
          </ShowcaseSection>

          <ShowcaseSection
            id="data"
            eyebrow="Components"
            title="Data display"
            description="Cards, tables, tabs, avatars, and accordions for surfacing tunnel activity."
          >
            <div className="flex flex-col gap-6">
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="wal-glow border-[rgba(202,177,255,0.28)]">
                  <CardHeader>
                    <CardTitle>Coin Flip</CardTitle>
                    <CardDescription>
                      Provably fair · commit-reveal
                    </CardDescription>
                    <CardAction>
                      <Badge className="border-transparent bg-[#EAFF80] text-[#0C0F1D]">
                        Live
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    Pot <span className="text-foreground">100 SUI</span> · 3,204
                    rounds settled off-chain.
                  </CardContent>
                  <CardFooter className="gap-2">
                    <Button size="sm">Join</Button>
                    <Button size="sm" variant="outline">
                      Watch
                    </Button>
                  </CardFooter>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Players</CardTitle>
                    <CardDescription>Connected to this tunnel</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <AvatarGroup>
                      <Avatar>
                        <AvatarFallback>AL</AvatarFallback>
                      </Avatar>
                      <Avatar>
                        <AvatarFallback>BO</AvatarFallback>
                      </Avatar>
                      <Avatar>
                        <AvatarFallback>CA</AvatarFallback>
                      </Avatar>
                      <AvatarGroupCount>+5</AvatarGroupCount>
                    </AvatarGroup>
                    <div className="flex items-center gap-3">
                      <Avatar size="lg">
                        <AvatarFallback>DA</AvatarFallback>
                        <AvatarBadge
                          style={{ background: "var(--wal-mint)" }}
                        />
                      </Avatar>
                      <div className="text-sm">
                        <div className="text-foreground">Dealer (you)</div>
                        <div className="text-muted-foreground">online</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Tabs defaultValue="ledger">
                <TabsList>
                  <TabsTrigger value="ledger">Ledger</TabsTrigger>
                  <TabsTrigger value="disputes">Disputes</TabsTrigger>
                  <TabsTrigger value="config">Config</TabsTrigger>
                </TabsList>
                <TabsContent value="ledger" className="pt-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nonce</TableHead>
                        <TableHead>Party</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[
                        {
                          nonce: 42,
                          party: "Alice",
                          action: "pay",
                          amount: "-3.10",
                        },
                        {
                          nonce: 41,
                          party: "Bob",
                          action: "pay",
                          amount: "+1.00",
                        },
                        {
                          nonce: 40,
                          party: "Alice",
                          action: "deposit",
                          amount: "+50.00",
                        },
                      ].map((row) => (
                        <TableRow key={row.nonce}>
                          <TableCell className="wal-mono tabular-nums text-muted-foreground">
                            {row.nonce}
                          </TableCell>
                          <TableCell>{row.party}</TableCell>
                          <TableCell>{row.action}</TableCell>
                          <TableCell
                            className="text-right tabular-nums"
                            style={{
                              color: row.amount.startsWith("-")
                                ? "var(--destructive)"
                                : "var(--wal-mint)",
                            }}
                          >
                            {row.amount} SUI
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TabsContent>
                <TabsContent
                  value="disputes"
                  className="pt-4 text-sm text-muted-foreground"
                >
                  No open disputes. Either party can force settlement at any
                  time.
                </TabsContent>
                <TabsContent
                  value="config"
                  className="pt-4 text-sm text-muted-foreground"
                >
                  Timeout 60s · penalty 1% · ed25519 signatures.
                </TabsContent>
              </Tabs>

              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="what">
                  <AccordionTrigger>What is a tunnel?</AccordionTrigger>
                  <AccordionContent>
                    A two-party state channel: open and close on-chain, transact
                    freely off-chain in between.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="fees">
                  <AccordionTrigger>What does it cost?</AccordionTrigger>
                  <AccordionContent>
                    Two on-chain transactions to open and one to settle. Every
                    update in between is free.
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </ShowcaseSection>

          <ShowcaseSection
            id="overlays"
            eyebrow="Components"
            title="Overlays"
            description="Dialogs and menus that portal above the page — they pick up the active theme too."
          >
            <ShowcaseItem label="Triggers">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Settle tunnel</DialogTitle>
                    <DialogDescription>
                      Submit the final agreed state to unlock funds for both
                      parties.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-2 py-2">
                    <Label htmlFor="ds-final">Final balance (you)</Label>
                    <Input id="ds-final" defaultValue="80.00 SUI" />
                  </div>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost">Cancel</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button onClick={() => toast.success("Tunnel settled")}>
                        <Check /> Confirm
                      </Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Settings /> Account
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>0x9f…3c1a</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                    <User /> Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <CreditCard /> Deposits
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Bell /> Notifications
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive">
                    <LogOut /> Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy address"
                    onClick={() => toast("Address copied")}
                  >
                    <Copy />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy address</TooltipContent>
              </Tooltip>
            </ShowcaseItem>
          </ShowcaseSection>
        </main>

        <footer className="border-t border-border">
          <div className="wal-mono mx-auto max-w-5xl px-6 py-6 text-xs text-muted-foreground">
            MillionsTPS · walrus design language · shadcn/ui on tailwind v4
          </div>
        </footer>
      </div>
    </div>
  );
}
