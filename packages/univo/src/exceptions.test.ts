import { test, expect } from "vitest";
import { catchException, createException, getException } from "./exceptions";

test.concurrent("should only catch known exceptions", () => {
	const UpdateSyncProgressFailed = createException("Unable to update a sync that isn't in progress");
	expect(catchException(new Error(), UpdateSyncProgressFailed)).toBe(false);
	expect(catchException(new Error(UpdateSyncProgressFailed), UpdateSyncProgressFailed)).toBe(true);
});

test.concurrent("should transform an unknown exception to a known exception", () => {
	const exception = "Unable to update a sync that isn't in progress";

	const UpdateSyncProgressFailed = createException(exception);
	const error = new Error(UpdateSyncProgressFailed);

	expect(getException(error)).toEqual(exception);
});
