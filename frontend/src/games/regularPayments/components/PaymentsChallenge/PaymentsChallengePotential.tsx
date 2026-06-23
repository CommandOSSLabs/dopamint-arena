export default function PaymentsChallengePotential() {
  return (
    <div className="rounded-lg border border-green-500/35 bg-green-500/10 px-3 py-2.5">
      <div className="flex justify-between text-xs">
        <p>Potential Reward</p>

        <div className="font-semibold text-green-400 flex gap-2">
          +0.1{" "}
          <span className="bg-[#4da2ff] flex items-center justify-center size-4 rounded-full">
            <img src="/icons/sui.png" className="size-2.5 object-contain" />
          </span>
        </div>
      </div>
    </div>
  );
}
