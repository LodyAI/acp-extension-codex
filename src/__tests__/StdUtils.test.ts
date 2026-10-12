import {PassThrough, Writable} from "node:stream";
import {describe, expect, it, vi} from "vitest";

import {createJSONRPCReader, createLineWriter, createJsonStream, settledWithin} from "../StdUtils";

describe("createJSONRPCReader", () => {
    it("preserves UTF-8 characters split across stdout chunks", () => {
        const stdout = new PassThrough();
        const onMessage = vi.fn();
        createJSONRPCReader(stdout).listen(onMessage);

        const prefix = Buffer.from('{"method":"test","params":{"title":"');
        const firstCharacter = Buffer.from("\u4F60");
        stdout.write(Buffer.concat([prefix, firstCharacter.subarray(0, 2)]));
        stdout.write(Buffer.concat([firstCharacter.subarray(2), Buffer.from('\u597D"}}\n')]));

        expect(onMessage).toHaveBeenCalledOnce();
        expect(onMessage).toHaveBeenCalledWith({
            jsonrpc: "2.0",
            method: "test",
            params: {title: "\u4F60\u597D"},
        });
    });
});

/** A stream that keeps each write callback until the test calls `release`, and then calls back at once. */
function slowWritable(highWaterMark: number) {
    const written: string[] = [];
    let held: ((error?: Error | null) => void) | undefined;
    let released = false;
    const writable = new Writable({
        highWaterMark,
        write(chunk: Buffer, _encoding, callback) {
            written.push(chunk.toString("utf8"));
            if (released) callback(); else held = callback;
        },
    });
    const release = (error?: Error) => {
        released = true;
        held?.(error);
    };
    return {writable, written, release};
}

function settled(promise: Promise<unknown>): Promise<string> {
    return Promise.race([
        promise.then(() => "resolved", (error: Error) => `rejected: ${error.message}`),
        new Promise<string>(resolve => setTimeout(() => resolve("pending"), 20)),
    ]);
}

describe("createLineWriter", () => {
    it("waits for drain when the stream buffer is full", async () => {
        const {writable, written, release} = slowWritable(16);
        const writeLine = createLineWriter(writable);

        expect(await settled(writeLine("short\n"))).toBe("resolved");
        const large = writeLine("x".repeat(1024) + "\n");
        expect(await settled(large)).toBe("pending");

        release();
        expect(await settled(large)).toBe("resolved");
        expect(written).toEqual(["short\n", "x".repeat(1024) + "\n"]);
    });

    it("rejects the waiting write and each later write when the stream fails", async () => {
        const {writable, release} = slowWritable(16);
        const writeLine = createLineWriter(writable);
        const waiting = writeLine("x".repeat(1024) + "\n");

        release(Object.assign(new Error("write EPIPE"), {code: "EPIPE"}));

        expect(await settled(waiting)).toBe("rejected: write EPIPE");
        expect(await settled(writeLine("next\n"))).toBe("rejected: write EPIPE");
        // A later error of the stream is not an uncaught exception.
        writable.emit("error", new Error("write EPIPE"));
    });

    it("rejects a write after the stream ended", async () => {
        const writable = new PassThrough();
        writable.resume();
        const writeLine = createLineWriter(writable);
        writable.end();
        await new Promise(resolve => writable.on("finish", resolve));
        await new Promise(resolve => setImmediate(resolve));

        expect(await settled(writeLine("late\n"))).toBe("rejected: The output stream ended");
    });
});

describe("createJsonStream", () => {
    it("writes each message as one JSON line with the bytes of JSON.stringify", async () => {
        const output = new PassThrough();
        const chunks: Buffer[] = [];
        output.on("data", (chunk: Buffer) => chunks.push(chunk));
        const stream = createJsonStream(new PassThrough(), output);
        const message = {jsonrpc: "2.0" as const, method: "session/update", params: {text: "я \u2028 \ud83d\ude00 \ud800"}};

        const writer = stream.writable.getWriter();
        await writer.write(message);
        await writer.write({jsonrpc: "2.0", id: 1, result: {}});

        expect(Buffer.concat(chunks)).toEqual(Buffer.from(
            new TextEncoder().encode(JSON.stringify(message) + "\n" + JSON.stringify({jsonrpc: "2.0", id: 1, result: {}}) + "\n"),
        ));
    });

    it("rejects a message write after the output stream failed", async () => {
        const {writable, release} = slowWritable(16);
        const stream = createJsonStream(new PassThrough(), writable);
        const writer = stream.writable.getWriter();
        const waiting = writer.write({jsonrpc: "2.0", method: "m", params: {text: "x".repeat(1024)}});
        expect(await settled(waiting)).toBe("pending");

        release(new Error("write EPIPE"));

        expect(await settled(waiting)).toBe("rejected: write EPIPE");
        expect(await settled(writer.write({jsonrpc: "2.0", id: 1, result: {}}))).toBe("rejected: write EPIPE");
    });
});

describe("settledWithin", () => {
    it("returns the value, or pending at the timeout, and rejects only before the timeout", async () => {
        vi.useFakeTimers();
        try {
            await expect(settledWithin(Promise.resolve("done"), 100)).resolves.toBe("done");
            await expect(settledWithin(Promise.reject(new Error("early")), 100)).rejects.toThrow("early");

            let rejectLate!: (error: Error) => void;
            const late = settledWithin(new Promise((_, reject) => { rejectLate = reject; }), 100);
            await vi.advanceTimersByTimeAsync(100);
            rejectLate(new Error("late"));
            await expect(late).resolves.toBe("pending");
        } finally {
            vi.useRealTimers();
        }
    });
});
