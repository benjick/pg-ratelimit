export type Strategy = "fixed-window" | "sliding-window" | "token-bucket";

export const strategies: {
  value: Strategy;
  label: string;
  description: string;
}[] = [
  { value: "fixed-window", label: "Fixed Window", description: "10 tokens per 10s window" },
  { value: "sliding-window", label: "Sliding Window", description: "10 tokens per 10s, smoothed" },
  { value: "token-bucket", label: "Token Bucket", description: "1 token/s, 10 max burst" },
];
