// Judgment qualification: whether a model has shown it can be trusted with a
// class of judgment, measured on a fixed corpus before its judgments of that
// class may enter belief revision.
//
// A checker existing is not a checker being competent. A model is qualified
// for a judgment class only by its measured accuracy on that class, per label,
// and by answering a proposition and its opposite consistently. An
// unqualified model's judgments of the class are void: they are recorded, but
// they move no belief, for or against.
//
// The corpus asks each item exactly as the runtime asks it (one premise, one
// proposition, one call). Opposites appear only here, to measure whether the
// model tells a proposition from its negation; the runtime never doubles its
// calls to do so.
export const JUDGMENT_CAPABILITIES = ["atomic-entailment"];
export const ENTAILMENT_LABELS = ["entailment", "contradiction", "neutral"];
// The runtime contract for an atomic entailment judgment, in the premise and
// hypothesis form these models met in training (NLI). Measured on the 1.2B:
// 17/30 against 14/30 for a supported/contradicted/unknown label.
export const atomicEntailmentContract = {
    name: "speck-atomic-entailment",
    description: "label: \"entailment\" if the premise means the hypothesis is true, \"contradiction\" if the premise means the hypothesis is false, \"neutral\" otherwise.",
    required: ["label"],
    properties: { label: { type: "string", enum: [...ENTAILMENT_LABELS] } },
    additionalProperties: false
};
export function entailmentPrompt(premise, hypothesis) {
    return `PREMISE:\n${premise}\n\nHYPOTHESIS:\n${hypothesis}`;
}
// One atomic entailment judgment as a request: the prompt for a model that
// reads one, and the same operands as fields for one that does not (an NLI
// cross-encoder).
export function entailmentRequest(premise, hypothesis) {
    return { contract: atomicEntailmentContract, instruction: entailmentPrompt(premise, hypothesis), input: { premise, hypothesis } };
}
export function entailmentLabel(value) {
    return ENTAILMENT_LABELS.includes(value) ? value : null;
}
export const opposed = (label) => label === "entailment" ? "contradiction" : label === "contradiction" ? "entailment" : "neutral";
// Version of the corpus a qualification was measured on; a qualification on
// an older corpus does not count.
export const ATOMIC_ENTAILMENT_CORPUS_VERSION = "atomic-entailment/4";
// General cases, no domain of any test: time, quantity, agency, state
// change, explicit and hard negation ("never", "no longer", "failed to",
// "neither … nor", "only", "except", double negation), and unrelated detail,
// including neutral cases that tempt a causal reading (an event near in time
// is not its cause). 90 pairs: 30 of each label for the proposition, which
// with the opposites gives 60 entailment, 60 contradiction and 60 neutral
// items per repetition.
export const ATOMIC_ENTAILMENT_CORPUS = [
    { premise: "The bakery opened at 7 AM and was full of customers by 8.", proposition: "The bakery was open at 8 AM.", opposite: "The bakery was closed at 8 AM.", label: "entailment" },
    { premise: "Maria locked the front door before she left for work.", proposition: "The front door was left unlocked when Maria left.", opposite: "The front door was locked when Maria left.", label: "contradiction" },
    { premise: "The bridge was repainted last spring.", proposition: "The bridge was repaired after a crash.", opposite: "The bridge was not repaired after a crash.", label: "neutral" },
    { premise: "The patient's fever broke overnight and she was discharged in the morning.", proposition: "The patient still had a fever when she was discharged.", opposite: "The patient no longer had a fever when she was discharged.", label: "contradiction" },
    { premise: "Tom finished the marathon in just under four hours.", proposition: "Tom completed the marathon.", opposite: "Tom did not complete the marathon.", label: "entailment" },
    { premise: "The shipment left the warehouse on Monday and arrived on Thursday.", proposition: "The shipment arrived before Tuesday.", opposite: "The shipment did not arrive before Tuesday.", label: "contradiction" },
    { premise: "Only two of the five lights in the hallway work.", proposition: "Most of the hallway lights are broken.", opposite: "Most of the hallway lights work.", label: "entailment" },
    { premise: "The library's heating failed, so it closed early on Friday.", proposition: "The library stayed open late on Friday.", opposite: "The library did not stay open late on Friday.", label: "contradiction" },
    { premise: "Sam's phone battery was fully charged when he left home.", proposition: "Sam's phone was running out of battery when he left home.", opposite: "Sam's phone had plenty of battery when he left home.", label: "contradiction" },
    { premise: "The committee met on Tuesday to discuss the budget.", proposition: "The committee approved the budget.", opposite: "The committee did not approve the budget.", label: "neutral" },
    { premise: "The river rose above the flood line after three days of rain.", proposition: "It was dry for the three days before the river rose.", opposite: "It rained during the three days before the river rose.", label: "contradiction" },
    { premise: "Priya has never been to Japan.", proposition: "Priya visited Tokyo last year.", opposite: "Priya did not visit Tokyo last year.", label: "contradiction" },
    { premise: "The cake was baked by Leo, and Ana decorated it.", proposition: "Ana baked the cake.", opposite: "Ana did not bake the cake.", label: "contradiction" },
    { premise: "The software update installed successfully, and the laptop restarted normally.", proposition: "The update failed to install.", opposite: "The update installed.", label: "contradiction" },
    { premise: "The museum is closed on Mondays.", proposition: "The museum's gift shop sells postcards.", opposite: "The museum's gift shop does not sell postcards.", label: "neutral" },
    { premise: "After the repair, the car started on the first try every morning that week.", proposition: "The car still would not start after the repair.", opposite: "The car started reliably after the repair.", label: "contradiction" },
    { premise: "The meeting was moved from 3 PM to 4 PM.", proposition: "The meeting took place at 3 PM.", opposite: "The meeting did not take place at 3 PM.", label: "contradiction" },
    { premise: "Jack bought milk at the corner shop.", proposition: "Jack paid with a credit card.", opposite: "Jack did not pay with a credit card.", label: "neutral" },
    // Entailment, many through negation.
    { premise: "Every window in the house was closed before the storm.", proposition: "The kitchen window was closed before the storm.", opposite: "The kitchen window was open before the storm.", label: "entailment" },
    { premise: "Nina never drinks coffee.", proposition: "Nina did not have coffee this morning.", opposite: "Nina had coffee this morning.", label: "entailment" },
    { premise: "The concert was not cancelled; it went ahead as planned.", proposition: "The concert took place.", opposite: "The concert did not take place.", label: "entailment" },
    { premise: "None of the three printers in the office were working on Monday.", proposition: "All of the office's printers were out of order on Monday.", opposite: "At least one of the office's printers worked on Monday.", label: "entailment" },
    { premise: "Leo no longer lives in Berlin; he moved to Lisbon in May.", proposition: "Leo has lived in Lisbon since May.", opposite: "Leo has not lived in Lisbon since May.", label: "entailment" },
    { premise: "The train left at 9:40, ten minutes after its scheduled 9:30 departure.", proposition: "The train departed late.", opposite: "The train departed on time.", label: "entailment" },
    { premise: "It is not true that the shop was closed on Sunday.", proposition: "The shop was open on Sunday.", opposite: "The shop was closed on Sunday.", label: "entailment" },
    { premise: "The test failed to detect any virus in the sample.", proposition: "No virus was detected in the sample.", opposite: "A virus was detected in the sample.", label: "entailment" },
    { premise: "Omar answered all of the exam questions except the last one.", proposition: "Omar left one exam question unanswered.", opposite: "Omar answered every exam question.", label: "entailment" },
    { premise: "The bottle was empty by the time Grace arrived.", proposition: "There was nothing left in the bottle when Grace arrived.", opposite: "There was still some left in the bottle when Grace arrived.", label: "entailment" },
    { premise: "Only the manager has a key to the safe, and Ruth is the cashier, not the manager.", proposition: "Ruth does not have a key to the safe.", opposite: "Ruth has a key to the safe.", label: "entailment" },
    { premise: "The dog barked until midnight, then fell silent.", proposition: "The dog was quiet after midnight.", opposite: "The dog kept barking after midnight.", label: "entailment" },
    { premise: "Hannah was born in 1990 and her brother was born in 1985.", proposition: "Hannah's brother is older than Hannah.", opposite: "Hannah's brother is younger than Hannah.", label: "entailment" },
    { premise: "The package could not be delivered because no one was home.", proposition: "The package was not delivered.", opposite: "The package was delivered.", label: "entailment" },
    { premise: "The lake froze solid during the January cold snap.", proposition: "The lake was covered in ice in January.", opposite: "The lake had no ice in January.", label: "entailment" },
    { premise: "Neither Paul nor Rita attended the wedding.", proposition: "Rita was absent from the wedding.", opposite: "Rita attended the wedding.", label: "entailment" },
    { premise: "The bank approved the loan without asking for a guarantor.", proposition: "The loan was approved.", opposite: "The loan was refused.", label: "entailment" },
    // Contradiction.
    { premise: "The museum has been closed for renovation since March and has not reopened.", proposition: "The museum was open to visitors in April.", opposite: "The museum was not open to visitors in April.", label: "contradiction" },
    { premise: "The pilot landed the plane safely despite the engine fault.", proposition: "The plane crashed.", opposite: "The plane did not crash.", label: "contradiction" },
    { premise: "The thermometer read 38 degrees Celsius all afternoon.", proposition: "It was below freezing that afternoon.", opposite: "It was not below freezing that afternoon.", label: "contradiction" },
    { premise: "Kenji has not missed a single day of work this year.", proposition: "Kenji was absent from work on a day earlier this year.", opposite: "Kenji was not absent from work on any day earlier this year.", label: "contradiction" },
    { premise: "The box office sold every ticket for the show within an hour and had none left to sell after that.", proposition: "The box office was still selling tickets for the show the next day.", opposite: "The box office was not selling tickets for the show the next day.", label: "contradiction" },
    { premise: "The bridge reopened to traffic on Friday after repairs and has stayed open since.", proposition: "The bridge was closed to traffic on Saturday.", opposite: "The bridge was open to traffic on Saturday.", label: "contradiction" },
    { premise: "Lucy wrote the report alone, without help from anyone.", proposition: "Lucy's colleague co-wrote the report.", opposite: "Lucy's colleague did not co-write the report.", label: "contradiction" },
    { premise: "The fire alarm stayed silent throughout the drill.", proposition: "The fire alarm sounded during the drill.", opposite: "The fire alarm did not sound during the drill.", label: "contradiction" },
    { premise: "The parcel weighed 2 kilograms.", proposition: "The parcel weighed more than 5 kilograms.", opposite: "The parcel weighed 5 kilograms or less.", label: "contradiction" },
    // Neutral, many tempting a causal or adjacent-in-time reading.
    { premise: "Ahmed bought a new bicycle on Saturday.", proposition: "Ahmed's bicycle is red.", opposite: "Ahmed's bicycle is not red.", label: "neutral" },
    { premise: "The school holds its sports day every June.", proposition: "The school won a regional award last year.", opposite: "The school did not win a regional award last year.", label: "neutral" },
    { premise: "Mia called her sister on Tuesday evening.", proposition: "Mia's sister lives abroad.", opposite: "Mia's sister does not live abroad.", label: "neutral" },
    { premise: "The restaurant was busy on Friday night.", proposition: "The restaurant's chef is from Italy.", opposite: "The restaurant's chef is not from Italy.", label: "neutral" },
    { premise: "The company hired two new engineers in March.", proposition: "The company's profits rose in March.", opposite: "The company's profits did not rise in March.", label: "neutral" },
    { premise: "The garden has three apple trees.", proposition: "The apple trees were planted by the previous owner.", opposite: "The apple trees were not planted by the previous owner.", label: "neutral" },
    { premise: "Victor took the bus to work this morning.", proposition: "Victor's car was being repaired this morning.", opposite: "Victor's car was not being repaired this morning.", label: "neutral" },
    { premise: "The power went out at 6 PM.", proposition: "A storm caused the power cut.", opposite: "A storm did not cause the power cut.", label: "neutral" },
    { premise: "Sara arrived twenty minutes late for the meeting.", proposition: "Sara's train was delayed.", opposite: "Sara's train was not delayed.", label: "neutral" },
    { premise: "The window was broken when the owners returned.", proposition: "A burglar broke the window.", opposite: "A burglar did not break the window.", label: "neutral" },
    { premise: "The river level rose overnight.", proposition: "It rained upstream overnight.", opposite: "It did not rain upstream overnight.", label: "neutral" },
    { premise: "The laptop shut down during the presentation.", proposition: "The laptop's battery ran out.", opposite: "The laptop's battery did not run out.", label: "neutral" },
    { premise: "The team lost the final.", proposition: "The team's captain was injured during the final.", opposite: "The team's captain was not injured during the final.", label: "neutral" },
    { premise: "The milk in the fridge had gone sour.", proposition: "The fridge was broken.", opposite: "The fridge was not broken.", label: "neutral" },
    { premise: "Elena logged into her account at 8 AM, a minute before her files were deleted.", proposition: "Elena deleted her files.", opposite: "Elena did not delete her files.", label: "neutral" },
    { premise: "The crowd cheered when the singer appeared.", proposition: "The singer had won an award that year.", opposite: "The singer had not won an award that year.", label: "neutral" },
    // Entailment (version 3).
    { premise: "The shop sold out of bread before noon and was not restocked that day.", proposition: "There was no bread left in the shop that afternoon.", opposite: "There was still bread in the shop that afternoon.", label: "entailment" },
    { premise: "Ivan has worked at the hospital since 2015 and still works there.", proposition: "Ivan worked at the hospital in 2020.", opposite: "Ivan did not work at the hospital in 2020.", label: "entailment" },
    { premise: "The door cannot be opened without the code, and Mark does not know the code.", proposition: "Mark cannot open the door.", opposite: "Mark can open the door.", label: "entailment" },
    { premise: "All flights out of the airport were grounded all day on Tuesday because of fog.", proposition: "No plane took off from the airport on Tuesday.", opposite: "A plane took off from the airport on Tuesday.", label: "entailment" },
    { premise: "Zoe is taller than Max, and Max is taller than Ben.", proposition: "Zoe is taller than Ben.", opposite: "Zoe is not taller than Ben.", label: "entailment" },
    { premise: "The plant died after it was left without water for a month.", proposition: "The plant was not watered for a month.", opposite: "The plant was watered during that month.", label: "entailment" },
    { premise: "The vote passed with 30 in favour and 10 against.", proposition: "Most of those who voted were in favour.", opposite: "Most of those who voted were against.", label: "entailment" },
    { premise: "Chen has not eaten meat since he became a vegetarian in 2019.", proposition: "Chen did not eat meat in 2022.", opposite: "Chen ate meat in 2022.", label: "entailment" },
    { premise: "The email was sent at 9:05 and the reply arrived at 9:30.", proposition: "The reply arrived after the email was sent.", opposite: "The reply arrived before the email was sent.", label: "entailment" },
    { premise: "No student in the class failed the exam.", proposition: "Every student in the class passed the exam.", opposite: "Some student in the class failed the exam.", label: "entailment" },
    // Contradiction (version 3).
    { premise: "The road was closed to all traffic all weekend for resurfacing.", proposition: "Cars drove on the road on Saturday.", opposite: "No cars drove on the road on Saturday.", label: "contradiction" },
    { premise: "Fatima cannot drive and has never driven a car.", proposition: "Fatima drove herself to work yesterday.", opposite: "Fatima did not drive herself to work yesterday.", label: "contradiction" },
    { premise: "The experiment was repeated three times and gave the same result each time.", proposition: "The experiment gave a different result on the second run.", opposite: "The experiment gave the same result on the second run.", label: "contradiction" },
    { premise: "Every room in the hotel was occupied every night in August.", proposition: "The hotel had empty rooms in mid-August.", opposite: "The hotel had no empty rooms in mid-August.", label: "contradiction" },
    { premise: "Both of Anna's parents are teachers.", proposition: "Anna's father is not a teacher.", opposite: "Anna's father is a teacher.", label: "contradiction" },
    { premise: "The guard checked every bag at the entrance, and nobody got past without a check.", proposition: "Some visitors entered without having their bags checked.", opposite: "No visitors entered without having their bags checked.", label: "contradiction" },
    { premise: "The well had run completely dry by July.", proposition: "The well was full of water in July.", opposite: "The well was not full of water in July.", label: "contradiction" },
    { premise: "The match ended in a 2–2 draw.", proposition: "The home team won the match.", opposite: "The home team did not win the match.", label: "contradiction" },
    { premise: "Raj stayed home all day on Sunday.", proposition: "Raj went to the cinema on Sunday afternoon.", opposite: "Raj did not go to the cinema on Sunday afternoon.", label: "contradiction" },
    { premise: "The backup finished at 3:00 and every file was copied without error.", proposition: "Some files failed to copy during the backup.", opposite: "No files failed to copy during the backup.", label: "contradiction" },
    // Neutral (version 3), several where presence or nearness in time tempts
    // a causal reading.
    { premise: "The office moved to a new building in June.", proposition: "The new building is closer to the station.", opposite: "The new building is not closer to the station.", label: "neutral" },
    { premise: "Tim stayed late at work on Thursday.", proposition: "Tim's manager asked him to stay late.", opposite: "Tim's manager did not ask him to stay late.", label: "neutral" },
    { premise: "The website was slow on Monday morning.", proposition: "A software update was released on Monday morning.", opposite: "No software update was released on Monday morning.", label: "neutral" },
    { premise: "The car's tyre was flat in the morning.", proposition: "Someone let the air out of the tyre.", opposite: "No one let the air out of the tyre.", label: "neutral" },
    { premise: "The cat was hiding under the bed on Saturday evening.", proposition: "Fireworks were set off nearby on Saturday evening.", opposite: "No fireworks were set off nearby on Saturday evening.", label: "neutral" },
    { premise: "Lena bought a new phone in October.", proposition: "Lena's old phone was broken.", opposite: "Lena's old phone was not broken.", label: "neutral" },
    { premise: "The bakery raised its prices in spring.", proposition: "The cost of flour went up in spring.", opposite: "The cost of flour did not go up in spring.", label: "neutral" },
    { premise: "The security camera stopped recording at 11 PM.", proposition: "Someone switched off the camera at 11 PM.", opposite: "No one switched off the camera at 11 PM.", label: "neutral" },
    { premise: "A nurse was on duty in the ward when the patient fell.", proposition: "The nurse caused the patient's fall.", opposite: "The nurse did not cause the patient's fall.", label: "neutral" },
    { premise: "The train was crowded on Wednesday.", proposition: "There was a football match in the city on Wednesday.", opposite: "There was no football match in the city on Wednesday.", label: "neutral" }
];
// The causal test's propositions (2026-10-03), reported beside the corpus to
// see how qualification predicts the task; never used to qualify.
export const OUTAGE_TASK_SET = [
    { premise: "The restart command completed successfully at 2:13:18. The server remained healthy afterward.", proposition: "The restart left the server unhealthy or stopped.", opposite: "The restart left the server healthy and running.", label: "contradiction" },
    { premise: "The restart command completed successfully at 2:13:18. The server remained healthy afterward.", proposition: "The server went offline as a result of the restart command.", opposite: "The server stayed up after the restart command.", label: "contradiction" },
    { premise: "The audit log records Alice issuing a restart command at 2:13 AM.", proposition: "Alice issued a restart command shortly before 2:14 AM.", opposite: "Alice did not issue a restart command before 2:14 AM.", label: "entailment" },
    { premise: "At 2:14:03 the hypervisor recorded the virtual disk disappearing.", proposition: "A storage device became unavailable around 2:14 AM.", opposite: "All storage devices stayed available around 2:14 AM.", label: "entailment" },
    { premise: "At 2:14:03 the hypervisor recorded the virtual disk disappearing.", proposition: "The server's virtual disk was available at 2:14:03.", opposite: "The server's virtual disk was unavailable at 2:14:03.", label: "contradiction" },
    { premise: "The restart command completed successfully at 2:13:18. The server remained healthy afterward.", proposition: "A storage device became unavailable around 2:14 AM.", opposite: "All storage devices stayed available around 2:14 AM.", label: "neutral" },
    { premise: "The audit log records Alice issuing a restart command at 2:13 AM.", proposition: "The server went offline at 2:14 AM.", opposite: "The server stayed online at 2:14 AM.", label: "neutral" },
    { premise: "Ben had replaced a failing storage controller earlier that evening. Carla had no access to the hypervisor.", proposition: "Carla changed the hypervisor configuration.", opposite: "Carla did not change the hypervisor configuration.", label: "contradiction" },
    { premise: "Ben had replaced a failing storage controller earlier that evening. Carla had no access to the hypervisor.", proposition: "Ben replaced a storage controller that evening.", opposite: "Ben did not replace any storage controller that evening.", label: "entailment" }
];
// Shortcut S31 (docs/COGNITIVE_SHORTCUTS.md): what a model must show to be
// qualified, as the lower end of a 95% interval on its measured rate (Wilson)
// over at least 60 distinct items, not as a raw rate: one miss in 60 still
// qualifies (59/60 → 0.91), two do not (0.89), and a lucky small sample
// cannot switch on a poor checker. Contradiction and negation consistency carry the
// highest bars because a contradiction verdict can kill a hypothesis.
// Provisional, to be set from the measured spread.
export const QUALIFICATION_THRESHOLDS = {
    minimumSamples: 60,
    overall: 0.85,
    contradiction: 0.9,
    negationConsistency: 0.9
};
// The lower end of the 95% Wilson interval for a measured rate; 0 with no
// samples.
export function lowerBound(tally, z = 1.96) {
    if (!tally.total)
        return 0;
    const n = tally.total;
    const p = tally.correct / n;
    const centre = p + z * z / (2 * n);
    const spread = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return (centre - spread) / (1 + z * z / n);
}
export function scoreQualification(capability, answers, repetitions, meanLatencyMs, at = new Date().toISOString()) {
    const empty = () => ({ entailment: 0, contradiction: 0, neutral: 0, invalid: 0 });
    const confusion = { entailment: empty(), contradiction: empty(), neutral: empty() };
    const byLabel = { entailment: { correct: 0, total: 0 }, contradiction: { correct: 0, total: 0 }, neutral: { correct: 0, total: 0 } };
    const overall = { correct: 0, total: 0 };
    const negationConsistency = { correct: 0, total: 0 };
    const count = (expected, observed) => {
        confusion[expected][observed ?? "invalid"] += 1;
        byLabel[expected].total += 1;
        overall.total += 1;
        if (observed === expected) {
            byLabel[expected].correct += 1;
            overall.correct += 1;
        }
    };
    for (const answer of answers) {
        count(answer.pair.label, answer.proposition);
        count(opposed(answer.pair.label), answer.opposite);
        // Consistency is measured where the model committed on either side: a
        // model answering "neutral" to everything is never inconsistent, and
        // would otherwise score perfectly (the 0.6B did, 54/54).
        if (answer.proposition === "neutral" && answer.opposite === "neutral")
            continue;
        negationConsistency.total += 1;
        if (answer.proposition !== null && answer.opposite === opposed(answer.proposition))
            negationConsistency.correct += 1;
    }
    // Repetitions of an item are not independent samples (a deterministic
    // checker answers each the same every time), so bounds and sample counts
    // are taken over distinct items, at the rate measured across repetitions.
    const distinct = (tally) => ({ correct: tally.correct / Math.max(1, repetitions), total: tally.total / Math.max(1, repetitions) });
    const lowerBounds = {
        overall: lowerBound(distinct(overall)), contradiction: lowerBound(distinct(byLabel.contradiction)), negationConsistency: lowerBound(distinct(negationConsistency))
    };
    const sampled = [byLabel.entailment, byLabel.contradiction, byLabel.neutral, negationConsistency]
        .every((tally) => distinct(tally).total >= QUALIFICATION_THRESHOLDS.minimumSamples);
    const qualified = sampled
        && lowerBounds.overall >= QUALIFICATION_THRESHOLDS.overall
        && lowerBounds.contradiction >= QUALIFICATION_THRESHOLDS.contradiction
        && lowerBounds.negationConsistency >= QUALIFICATION_THRESHOLDS.negationConsistency;
    return {
        capability, corpus: ATOMIC_ENTAILMENT_CORPUS_VERSION, qualified, measuredAt: at, repetitions,
        overall, byLabel, confusion, negationConsistency, lowerBounds, meanLatencyMs, thresholds: QUALIFICATION_THRESHOLDS
    };
}
//# sourceMappingURL=qualification.js.map