import type { CourierExecution, CourierExecutionAttempt, CourierExecutionUnit } from "../courier.types";

export interface ICourierExecutionsRepository {
  findExecutionByRequestId(requestId: number, tx?: any): Promise<CourierExecution | null>;
  updateExecution(requestId: number, executionData: any, expectedVersion?: number, tx?: any): Promise<CourierExecution | null>;
  insertExecution(executionData: any, tx?: any): Promise<CourierExecution>;
  findExecutionAttempts(requestId: number, tx?: any): Promise<CourierExecutionAttempt[]>;
  insertExecutionAttempt(attemptData: any, tx?: any): Promise<CourierExecutionAttempt>;
  /**
   * OPS-REMED-E4-P2: atomic compare-and-swap on
   * courier_executions.custody_closure_status — same idiom as
   * claimPdfReportForTransition (E12): `WHERE request_id=$1 AND
   * custody_closure_status IN (...fromStates)`, single UPDATE. Exactly one
   * caller can ever win a given transition; a losing/duplicate/late call
   * affects zero rows and returns null (never an error).
   */
  updateCustodyClosureStatus(
    requestId: number,
    fromStates: string[],
    toState: string,
    tx?: any
  ): Promise<CourierExecution | null>;
  /** Installation units of a close; written only inside the close transaction. */
  insertExecutionUnits(units: Omit<CourierExecutionUnit, "id" | "createdAt" | "simType">[], tx?: any): Promise<CourierExecutionUnit[]>;
  findExecutionUnitsByRequestId(requestId: number, tx?: any): Promise<CourierExecutionUnit[]>;
}
