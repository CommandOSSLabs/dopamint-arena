use super::{
    current_initial_balance, current_max_moves_per_tunnel, play_with_strategies, MAX_MOVES,
};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};
use tunnel_payments::{PayMove, PayState, Payments};

struct AlternatingPaymentsStrategy {
    payment_amount: u64,
}

impl MoveStrategy<Payments> for AlternatingPaymentsStrategy {
    async fn plan_move(
        &mut self,
        state: &PayState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<PayMove> {
        let payer = if state.count % 2 == 0 {
            Seat::A
        } else {
            Seat::B
        };
        if seat != payer {
            return None;
        }
        let balance = match seat {
            Seat::A => state.a,
            Seat::B => state.b,
        };
        (balance >= self.payment_amount).then_some(PayMove {
            from: seat,
            amount: self.payment_amount,
        })
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
    let initial_balance = current_initial_balance();
    let payment_amount = 1;
    let max_transfers = current_max_moves_per_tunnel();
    play_with_strategies(
        Payments { max_transfers },
        AlternatingPaymentsStrategy { payment_amount },
        AlternatingPaymentsStrategy { payment_amount },
        codec,
        anchor_mode,
        sui_context,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        initial_balance,
        initial_balance,
        MAX_MOVES,
        telemetry,
    )
    .await
}
