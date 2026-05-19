export interface OutboxResult {
  processed: number;
  sent: number;
  failed: number;
}
