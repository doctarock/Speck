// Corpus v5 additions (2026-10-22): 90 new contrastive pairs for atomic
// entailment, 30 per label, written before any model saw them. They cover
// the v4 corpus's categories in equal measure: time, quantity, agency, state
// change, hard negation, and inference or unrelated detail (including neutral
// cases that tempt a causal reading). They were not chosen by any model's
// errors: they exist so that a checker's verdicts can be measured on enough
// distinct items for the 95% lower bounds to mean something
// (docs/experiments/qualification/README.md, 2026-10-22).
//
// Each pair: the proposition's label against the premise; the opposite is its
// negation or contrary, whose label is the opposed one (entailment ↔
// contradiction, neutral ↔ neutral).

import type { ContrastivePair } from "./qualification.js";

const E = "entailment" as const;
const C = "contradiction" as const;
const N = "neutral" as const;

export const CORPUS_V5_ADDITIONS: readonly ContrastivePair[] = [
  // ---- entailment: time
  { premise: "The museum opens at 10 AM and closes at 5 PM every day.", proposition: "The museum is open at noon.", opposite: "The museum is closed at noon.", label: E },
  { premise: "Jun boarded the 6:15 train, which reached the city at 7:40.", proposition: "Jun reached the city before 8:00.", opposite: "Jun did not reach the city before 8:00.", label: E },
  { premise: "The concert was moved from Saturday to the following Monday.", proposition: "The concert did not take place on Saturday.", opposite: "The concert took place on Saturday.", label: E },
  { premise: "Lena has lived in Oslo since 2015 and has never moved.", proposition: "Lena lived in Oslo in 2019.", opposite: "Lena did not live in Oslo in 2019.", label: E },
  { premise: "The meeting ended an hour before lunch, and lunch was at 1 PM.", proposition: "The meeting was over by noon.", opposite: "The meeting was still going at noon.", label: E },
  // ---- entailment: quantity
  { premise: "There are twelve eggs in the carton and none of them are broken.", proposition: "The carton holds more than ten unbroken eggs.", opposite: "The carton holds fewer than ten unbroken eggs.", label: E },
  { premise: "All four tyres on the van were replaced on Tuesday.", proposition: "The van got new tyres on Tuesday.", opposite: "The van did not get new tyres on Tuesday.", label: E },
  { premise: "Ravi scored 92 out of 100 on the exam, and the pass mark was 50.", proposition: "Ravi passed the exam.", opposite: "Ravi failed the exam.", label: E },
  { premise: "Every seat on the bus was taken, and three people had to stand.", proposition: "The bus had no empty seats.", opposite: "The bus had empty seats.", label: E },
  { premise: "The recipe needs three cups of flour, and Ana used exactly that amount.", proposition: "Ana used three cups of flour.", opposite: "Ana did not use three cups of flour.", label: E },
  // ---- entailment: agency
  { premise: "The manager signed the contract herself.", proposition: "The manager signed the contract.", opposite: "The manager did not sign the contract.", label: E },
  { premise: "Sam's neighbour fed Sam's cat while Sam was away.", proposition: "Someone fed Sam's cat while Sam was away.", opposite: "Nobody fed Sam's cat while Sam was away.", label: E },
  { premise: "The children built the snowman without any help.", proposition: "The children built the snowman.", opposite: "The children did not build the snowman.", label: E },
  { premise: "Priya wrote the report, and Omar only proofread it.", proposition: "Priya wrote the report.", opposite: "Priya did not write the report.", label: E },
  { premise: "The council voted to close the old swimming pool.", proposition: "The council made a decision about the old swimming pool.", opposite: "The council made no decision about the old swimming pool.", label: E },
  // ---- entailment: state change
  { premise: "The ice on the pond had melted completely by the start of March.", proposition: "There was no ice on the pond at the end of March.", opposite: "There was still ice on the pond at the end of March.", label: E },
  { premise: "The shop was painted blue last year; before that it was green.", proposition: "The shop used to be green.", opposite: "The shop was never green.", label: E },
  { premise: "Hugo quit smoking five years ago and has not smoked since.", proposition: "Hugo does not smoke now.", opposite: "Hugo smokes now.", label: E },
  { premise: "The printer jammed, and the technician fixed it this morning.", proposition: "The printer was repaired this morning.", opposite: "The printer was not repaired this morning.", label: E },
  { premise: "The river flooded the road, so the road was closed until the water went down.", proposition: "The road was closed for a time.", opposite: "The road was never closed.", label: E },
  // ---- entailment: hard negation
  { premise: "None of the guests stayed after midnight.", proposition: "Every guest had left by midnight.", opposite: "Some guests stayed after midnight.", label: E },
  { premise: "Neither Kofi nor Ama has visited Japan.", proposition: "Ama has not visited Japan.", opposite: "Ama has visited Japan.", label: E },
  { premise: "The bakery no longer sells rye bread.", proposition: "The bakery does not sell rye bread now.", opposite: "The bakery sells rye bread now.", label: E },
  { premise: "It is not true that the gate was left open.", proposition: "The gate was not left open.", opposite: "The gate was left open.", label: E },
  { premise: "Everyone except Lucia passed the driving test.", proposition: "Lucia did not pass the driving test.", opposite: "Lucia passed the driving test.", label: E },
  // ---- entailment: inference
  { premise: "Dana is older than Eli, and Eli is older than Finn.", proposition: "Dana is older than Finn.", opposite: "Dana is not older than Finn.", label: E },
  { premise: "The parcel was delivered to the wrong address and then returned to the sender.", proposition: "The parcel went back to the sender.", opposite: "The parcel did not go back to the sender.", label: E },
  { premise: "Mei is a vegetarian and has eaten no meat for ten years.", proposition: "Mei did not eat meat last year.", opposite: "Mei ate meat last year.", label: E },
  { premise: "The doctor confirmed that the bone was broken.", proposition: "The bone was broken.", opposite: "The bone was not broken.", label: E },
  { premise: "The flight was cancelled, so no passengers flew on it.", proposition: "Nobody flew on the flight.", opposite: "Some passengers flew on the flight.", label: E },

  // ---- contradiction: time
  { premise: "The library closes at 6 PM on weekdays.", proposition: "The library is open at 8 PM on a Tuesday.", opposite: "The library is closed at 8 PM on a Tuesday.", label: C },
  { premise: "The race started at noon, and Ella finished it two hours later.", proposition: "Ella finished the race at 1 PM.", opposite: "Ella did not finish the race at 1 PM.", label: C },
  { premise: "Felix was born in 1990.", proposition: "Felix was born after 2000.", opposite: "Felix was not born after 2000.", label: C },
  { premise: "The bridge opened in May and has not closed since.", proposition: "The bridge was closed in June.", opposite: "The bridge was open in June.", label: C },
  { premise: "Kim arrived after the film had already started.", proposition: "Kim arrived before the film started.", opposite: "Kim did not arrive before the film started.", label: C },
  // ---- contradiction: quantity
  { premise: "The jar contains exactly seven marbles.", proposition: "The jar contains ten marbles.", opposite: "The jar does not contain ten marbles.", label: C },
  { premise: "Only one of the three printers works.", proposition: "Two of the printers work.", opposite: "Fewer than two of the printers work.", label: C },
  { premise: "The hall seats 200 people and was half full.", proposition: "The hall was full.", opposite: "The hall was not full.", label: C },
  { premise: "Tariq has two sisters and no brothers.", proposition: "Tariq has a brother.", opposite: "Tariq has no brother.", label: C },
  { premise: "The bottle was empty after Nina drank the last of the water.", proposition: "There was water left in the bottle.", opposite: "There was no water left in the bottle.", label: C },
  // ---- contradiction: agency
  { premise: "Grace cooked dinner by herself; nobody helped her.", proposition: "Ian helped Grace cook dinner.", opposite: "Ian did not help Grace cook dinner.", label: C },
  { premise: "A falling branch broke the window during the storm.", proposition: "The window was never broken.", opposite: "The window was broken.", label: C },
  { premise: "Luis was in hospital all week and could not go to work.", proposition: "Luis worked at the office on the Wednesday of that week.", opposite: "Luis did not work at the office on the Wednesday of that week.", label: C },
  { premise: "The teacher marked every essay herself.", proposition: "None of the essays were marked.", opposite: "Some of the essays were marked.", label: C },
  { premise: "Zara turned down the job offer.", proposition: "Zara accepted the job offer.", opposite: "Zara did not accept the job offer.", label: C },
  // ---- contradiction: state change
  { premise: "The lake froze over in January and stayed frozen until March.", proposition: "The lake was not frozen in February.", opposite: "The lake was frozen in February.", label: C },
  { premise: "The old factory was demolished in 2019.", proposition: "The old factory was still standing in 2021.", opposite: "The old factory was not standing in 2021.", label: C },
  { premise: "Owen sold his car last spring and now takes the bus.", proposition: "Owen still owns that car.", opposite: "Owen no longer owns that car.", label: C },
  { premise: "The milk had gone sour, so Paula poured it away.", proposition: "The milk was fresh.", opposite: "The milk was not fresh.", label: C },
  { premise: "The battery is fully charged.", proposition: "The battery is empty.", opposite: "The battery is not empty.", label: C },
  // ---- contradiction: hard negation
  { premise: "No one in the office speaks German.", proposition: "Two people in the office speak German.", opposite: "Nobody in the office speaks German.", label: C },
  { premise: "Hana has never been to Brazil.", proposition: "Hana went to Brazil last year.", opposite: "Hana did not go to Brazil last year.", label: C },
  { premise: "The café stopped serving breakfast in 2020 and has not served it since.", proposition: "The café served breakfast in 2023.", opposite: "The café did not serve breakfast in 2023.", label: C },
  { premise: "Neither the front door nor the back door was locked.", proposition: "The back door was locked.", opposite: "The back door was not locked.", label: C },
  { premise: "All of the tickets were sold except two.", proposition: "Every ticket was sold.", opposite: "Not every ticket was sold.", label: C },
  // ---- contradiction: inference
  { premise: "Pia is shorter than Quinn, and Quinn is shorter than Rosa.", proposition: "Pia is taller than Rosa.", opposite: "Pia is not taller than Rosa.", label: C },
  { premise: "The store is closed on Sundays, and today is Sunday.", proposition: "The store is open today.", opposite: "The store is not open today.", label: C },
  { premise: "Every member of the club voted, and the vote was unanimously in favour.", proposition: "Some members voted against.", opposite: "No members voted against.", label: C },
  { premise: "The test came back negative for the virus.", proposition: "The test found the virus.", opposite: "The test did not find the virus.", label: C },
  { premise: "Arjun lost his keys and has not found them yet.", proposition: "Arjun has his keys with him now.", opposite: "Arjun does not have his keys with him now.", label: C },

  // ---- neutral: time
  { premise: "The train left the station at 9 AM.", proposition: "The train was full.", opposite: "The train was not full.", label: N },
  { premise: "Sara visited her grandmother on Sunday.", proposition: "Sara drove to her grandmother's house.", opposite: "Sara did not drive to her grandmother's house.", label: N },
  { premise: "The museum reopened after renovations in June.", proposition: "The renovations cost more than planned.", opposite: "The renovations did not cost more than planned.", label: N },
  { premise: "Tom woke up at 6 AM.", proposition: "Tom ate breakfast before 7 AM.", opposite: "Tom did not eat breakfast before 7 AM.", label: N },
  { premise: "The meeting was held on the third floor.", proposition: "The meeting started late.", opposite: "The meeting did not start late.", label: N },
  // ---- neutral: quantity
  { premise: "The farm has forty sheep.", proposition: "The farm has more than ten cows.", opposite: "The farm does not have more than ten cows.", label: N },
  { premise: "Lily bought three apples at the market.", proposition: "Lily bought bread at the market.", opposite: "Lily did not buy bread at the market.", label: N },
  { premise: "The school has 500 students.", proposition: "Most of the students walk to school.", opposite: "Most of the students do not walk to school.", label: N },
  { premise: "The town has two bakeries.", proposition: "One of the bakeries sells cakes.", opposite: "Neither bakery sells cakes.", label: N },
  { premise: "Max ran five kilometres this morning.", proposition: "Max ran faster than he did last week.", opposite: "Max did not run faster than he did last week.", label: N },
  // ---- neutral: agency (and causal temptation)
  { premise: "The vase in the hall is broken.", proposition: "The cat broke the vase.", opposite: "The cat did not break the vase.", label: N },
  { premise: "Ines was at the party when the music stopped.", proposition: "Ines turned off the music.", opposite: "Ines did not turn off the music.", label: N },
  { premise: "The report was finished on Friday.", proposition: "Jorge wrote the report.", opposite: "Jorge did not write the report.", label: N },
  { premise: "Someone left the lights on in the office overnight.", proposition: "The cleaner left the lights on.", opposite: "The cleaner did not leave the lights on.", label: N },
  { premise: "The car had a dent after the weekend.", proposition: "Mira drove the car into a post.", opposite: "Mira did not drive the car into a post.", label: N },
  // ---- neutral: state change
  { premise: "The plant on the windowsill has new leaves.", proposition: "The plant was watered yesterday.", opposite: "The plant was not watered yesterday.", label: N },
  { premise: "The road was resurfaced in August.", proposition: "The road had potholes before August.", opposite: "The road had no potholes before August.", label: N },
  { premise: "Yusuf moved to a new flat in March.", proposition: "The new flat is bigger than his old one.", opposite: "The new flat is not bigger than his old one.", label: N },
  { premise: "The shop changed its name last month.", proposition: "The shop changed owners last month.", opposite: "The shop did not change owners last month.", label: N },
  { premise: "The internet went down at 3 PM.", proposition: "The internet came back by 4 PM.", opposite: "The internet did not come back by 4 PM.", label: N },
  // ---- neutral: negation and causal temptation
  { premise: "Nobody answered the phone at the clinic.", proposition: "The clinic was closed.", opposite: "The clinic was not closed.", label: N },
  { premise: "Eva did not go to the gym on Monday.", proposition: "Eva was ill on Monday.", opposite: "Eva was not ill on Monday.", label: N },
  { premise: "The bus did not stop at Elm Street.", proposition: "Elm Street was closed for roadworks.", opposite: "Elm Street was not closed for roadworks.", label: N },
  { premise: "Only Noah knew the password.", proposition: "Noah changed the password.", opposite: "Noah did not change the password.", label: N },
  { premise: "The power cut happened just after the storm began.", proposition: "The storm caused the power cut.", opposite: "The storm did not cause the power cut.", label: N },
  // ---- neutral: unrelated detail
  { premise: "Aisha speaks three languages.", proposition: "Aisha plays the piano.", opposite: "Aisha does not play the piano.", label: N },
  { premise: "The bakery sold out of croissants by 9 AM.", proposition: "The bakery will bake more croissants tomorrow.", opposite: "The bakery will not bake more croissants tomorrow.", label: N },
  { premise: "Ben's phone screen cracked when it fell.", proposition: "Ben's phone still works.", opposite: "Ben's phone does not work.", label: N },
  { premise: "The alarm went off at 2 AM.", proposition: "A burglar set off the alarm.", opposite: "A burglar did not set off the alarm.", label: N },
  { premise: "Clara finished the crossword in ten minutes.", proposition: "Clara did the crossword on a train.", opposite: "Clara did not do the crossword on a train.", label: N }
];
