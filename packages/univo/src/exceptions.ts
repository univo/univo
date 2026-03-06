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

/** Returns `message` if the exception is a known or `undefined` if not */
export function getException(unknown: unknown) {
	if (unknown instanceof Error) {
		if (unknown.message.startsWith("univo")) {
			const [_, message] = unknown.message.split(":");
			if (message) return message;
		}
	}
}
