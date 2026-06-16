export const getCardSum = (cards: number[]): number => {
  let sum = 0;
  let hasAce = false;

  cards.forEach((cardIndex) => {
    let value = (cardIndex % 13) + 1;
    if (value === 1) hasAce = true;
    if (value > 10) value = 10;
    sum += value;
  });

  if (hasAce && sum + 10 <= 21) {
    sum += 10;
  }

  return sum;
};
