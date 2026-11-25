// API errors: an HTTP status, a stable machine-readable code and a message for humans.

export class ApiError extends Error {
    /**
     * Creates an error the API returns as `{ error: { code, message } }`.
     * @param status - The HTTP status to answer with
     * @param code - A stable snake_case code clients can branch on
     * @param message - A human-readable explanation
     */
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}
