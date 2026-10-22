export type PredictionOperator = "equals" | "not-equals" | "exists" | "includes" | "gte" | "lte";

export interface PredictionCondition {
  path: string;
  operator: PredictionOperator;
  value?: unknown;
  weight?: number;
}

export interface PredictionSpec {
  description: string;
  confidence: number;
  sourceChannel: string;
  conditions: PredictionCondition[];
}

export interface ConditionComparison {
  condition: PredictionCondition;
  matched: boolean;
  observed: unknown;
  error: number;
}

export interface PredictionComparison {
  errorMagnitude: number;
  precision: number;
  precisionWeightedSurprise: number;
  epistemicValue: number;
  verdict: "confirmed" | "contradicted" | "uncertain";
  conditions: ConditionComparison[];
  comparedAt: string;
}
