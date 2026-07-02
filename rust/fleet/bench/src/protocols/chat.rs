use super::{current_initial_balance, play_with_strategies, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_chat::{Chat, ChatMove, ChatState};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};

struct AlternatingChatStrategy;

impl MoveStrategy<Chat> for AlternatingChatStrategy {
    async fn plan_move(
        &mut self,
        state: &ChatState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<ChatMove> {
        let next_seat = state.last_sender.map(Seat::other).unwrap_or(Seat::A);
        (seat == next_seat).then(|| ChatMove::plain(format!("msg{}", state.message_count)))
    }
}

pub(crate) async fn play(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome {
    let seed = card_seed.unwrap_or(0);
    let initial_balance = current_initial_balance();
    play_with_strategies(
        Chat,
        AlternatingChatStrategy,
        AlternatingChatStrategy,
        codec,
        anchor_mode,
        sui_context,
        seed,
        kit,
        tunnel_id,
        initial_balance,
        initial_balance,
        MAX_MOVES,
        telemetry,
    )
    .await
}
