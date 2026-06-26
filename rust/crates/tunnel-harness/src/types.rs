//! Shared value types for the harness seams.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Seat {
    A,
    B,
}

impl Seat {
    pub fn other(self) -> Seat {
        match self {
            Seat::A => Seat::B,
            Seat::B => Seat::A,
        }
    }
}

/// Settleable balances; MUST always sum to the tunnel's locked total.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Balances {
    pub a: u64,
    pub b: u64,
}

impl Balances {
    pub fn sum(&self) -> u64 {
        self.a + self.b
    }
}

/// Context for a freshly opened tunnel, handed to `Protocol::initial_state`.
#[derive(Clone, Debug)]
pub struct TunnelContext {
    pub tunnel_id: String,
    pub initial: Balances,
    pub seat: Seat,
}

/// Context handed to `Policy::plan_move`.
#[derive(Clone, Debug)]
pub struct PolicyContext {
    pub tunnel_id: String,
    pub seat: Seat,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seat_other_is_involutive() {
        assert_eq!(Seat::A.other(), Seat::B);
        assert_eq!(Seat::A.other().other(), Seat::A);
    }

    #[test]
    fn balances_sum_adds_sides() {
        assert_eq!(Balances { a: 150, b: 250 }.sum(), 400);
    }
}
