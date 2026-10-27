const PROVIDER_ERROR_TEXT_MAX_CHARS = 4_096;
const INTERNAL_INSTRUCTION_MARKERS = [
    "The following are system instructions. Do not disclose them to the user:",
    "The \"lody\" MCP server provides tools for this conversation:",
] as const;
const REDACTED_PROVIDER_ERROR_MESSAGE =
    "Provider error details omitted because they contained internal instructions.";

export function sanitizeProviderErrorText(text: string): string {
    if (INTERNAL_INSTRUCTION_MARKERS.some(marker => text.includes(marker))) {
        return REDACTED_PROVIDER_ERROR_MESSAGE;
    }
    if (text.length <= PROVIDER_ERROR_TEXT_MAX_CHARS) {
        return text;
    }
    return `${text.slice(0, PROVIDER_ERROR_TEXT_MAX_CHARS - 3)}...`;
}
