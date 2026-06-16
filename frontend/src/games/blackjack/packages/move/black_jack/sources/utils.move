
/// Module: black_jack
module black_jack::utils {
    use sui::hash::{blake2b256};
    use sui::address;

    public fun derive_random_u8_in_range(input_bytes: &vector<u8>, greater_than_or_equal_to: u8, less_than: u8): (u8, vector<u8>) {
        let rehash = blake2b256(input_bytes);

        let temp_address = address::from_bytes(rehash);
        let value = temp_address.to_u256();

        let range: u256 = (less_than as u256) - (greater_than_or_equal_to as u256);
        let random_number = ((value % range) as u8) + greater_than_or_equal_to;
        (random_number, rehash)
    }

    public fun create_vector_range(start: u8, end: u8): vector<u8> {
        let mut output_vector = vector::empty();
        let mut index = start;
        while (index < end) {
            output_vector.push_back(index);
            index = index + 1;
        };
        output_vector
    }

    /// Function get_card_sum
    ///
    /// Calculates the total value of a player's hand
    /// @param hand: A vector of card indices in the space [0-51] eg [5,48,12,7]
    ///
    /// We consider the following mapping between Move Contract and FrontEnd:
    ///
    /// index= 0,  suit: "Clubs", name-on-card: "A",  value: 1
    /// index= 1,  suit: "Clubs", name-on-card: "2",  value: 2
    /// index= 2,  suit: "Clubs", name-on-card: "3",  value: 3
    /// index= 3,  suit: "Clubs", name-on-card: "4",  value: 4
    /// index= 4,  suit: "Clubs", name-on-card: "5",  value: 5
    /// index= 5,  suit: "Clubs", name-on-card: "6",  value: 6
    /// index= 6,  suit: "Clubs", name-on-card: "7",  value: 7
    /// index= 7,  suit: "Clubs", name-on-card: "8",  value: 8
    /// index= 8,  suit: "Clubs", name-on-card: "9",  value: 9
    /// index= 9,  suit: "Clubs", name-on-card: "10", value: 10
    /// index= 10, suit: "Clubs", name-on-card: "J",  value: 10
    /// index= 11, suit: "Clubs", name-on-card: "Q",  value: 10
    /// index= 12, suit: "Clubs", name-on-card: "K",  value: 10
    ///
    /// index= 13, suit: "Diamonds", name-on-card: "A",  value: 1
    /// index= 14, suit: "Diamonds", name-on-card: "2",  value: 2
    /// index= 15, suit: "Diamonds", name-on-card: "3",  value: 3
    /// index= 16, suit: "Diamonds", name-on-card: "4",  value: 4
    /// index= 17, suit: "Diamonds", name-on-card: "5",  value: 5
    /// index= 18, suit: "Diamonds", name-on-card: "6",  value: 6
    /// index= 19, suit: "Diamonds", name-on-card: "7",  value: 7
    /// index= 20, suit: "Diamonds", name-on-card: "8",  value: 8
    /// index= 21, suit: "Diamonds", name-on-card: "9",  value: 9
    /// index= 22, suit: "Diamonds", name-on-card: "10", value: 10
    /// index= 23, suit: "Diamonds", name-on-card: "J",  value: 10
    /// index= 24, suit: "Diamonds", name-on-card: "Q",  value: 10
    /// index= 25, suit: "Diamonds", name-on-card: "K",  value: 10
    ///
    /// index= 26, suit: "Hearts", name-on-card:"A",  value: 1
    /// index= 27, suit: "Hearts", name-on-card:"2",  value: 2
    /// index= 28, suit: "Hearts", name-on-card:"3",  value: 3
    /// index= 29, suit: "Hearts", name-on-card:"4",  value: 4
    /// index= 30, suit: "Hearts", name-on-card:"5",  value: 5
    /// index= 31, suit: "Hearts", name-on-card:"6",  value: 6
    /// index= 32, suit: "Hearts", name-on-card:"7",  value: 7
    /// index= 33, suit: "Hearts", name-on-card:"8",  value: 8
    /// index= 34, suit: "Hearts", name-on-card:"9",  value: 9
    /// index= 35, suit: "Hearts", name-on-card:"10", value: 10
    /// index= 36, suit: "Hearts", name-on-card:"J",  value: 10
    /// index= 37, suit: "Hearts", name-on-card:"Q",  value: 10
    /// index= 38, suit: "Hearts", name-on-card:"K",  value: 10
    ///
    /// index= 39, suit: "Spades", name-on-card: "A",  value: 1
    /// index= 40, suit: "Spades", name-on-card: "2",  value: 2
    /// index= 41, suit: "Spades", name-on-card: "3",  value: 3
    /// index= 42, suit: "Spades", name-on-card: "4",  value: 4
    /// index= 43, suit: "Spades", name-on-card: "5",  value: 5
    /// index= 44, suit: "Spades", name-on-card: "6",  value: 6
    /// index= 45, suit: "Spades", name-on-card: "7",  value: 7
    /// index= 46, suit: "Spades", name-on-card: "8",  value: 8
    /// index= 47, suit: "Spades", name-on-card: "9",  value: 9
    /// index= 48, suit: "Spades", name-on-card: "10", value: 10
    /// index= 49, suit: "Spades", name-on-card: "J",  value: 10
    /// index= 50, suit: "Spades", name-on-card: "Q",  value: 10
    /// index= 51, suit: "Spades", name-on-card: "K",  value: 10
    ///

    public fun get_hand_sum(hand: &vector<u8>): u8 {
        let mut sum: u8 = 0;
        let mut i: u8 = 0;
        let n: u8 = (hand.length() as u8);
        let mut has_ace = false;

        while (i < n) {
            let cardIndex = hand[i as u64];

            let mut value = (cardIndex % 13) + 1 ;  // this constraints index to the space [1-13]
            // 1 = Ace
            // 2 = 2
            // 3 = 3
            //...
            // 10 = 10
            // 11 = J (value 10)
            // 12 = Q (value 10)
            // 13 = K (value 10)

            if (value == 1) {
                has_ace = true;
            };

            if (value > 10) {
                value = 10;
            };

            sum = sum + value;

            i = i + 1;
        };

        //We need to take care of the Aces case where value = 1 or 11 depending on the sum
        if (has_ace && sum + 10 <= 21) {
            sum = sum + 10;
        };

        sum
    }
}
