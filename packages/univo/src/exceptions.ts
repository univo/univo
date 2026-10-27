/** Creates a known exception */
export function createException(message: string) {
	return `univo:${message}`;
}

/** Returns true if `unknown` is an instance of `exception` */
export function catchException(unknown: unknown, exception: string) {
	if (unknown instanceof Error) {
		if (unknown.message === exception) {
			return true;
		}
	}

	return false;
}
