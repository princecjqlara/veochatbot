export function signInErrorMessage(code?: string | null) {
    if (code === 'DatabaseRecovery') return 'The workspace is in database recovery mode. Please try again after maintenance.';
    if (code === 'DatabaseUnavailable') return 'Sign-in is temporarily unavailable because the database is not responding. Please retry shortly.';
    if (code === 'TooManyAttempts') return 'Too many sign-in attempts. Wait 15 minutes or ask the Owner to reset your sign-in.';
    if (code === 'NetworkUnavailable') return 'The sign-in service could not be reached. Please retry shortly.';
    return 'Sign-in failed. Check the email and password. If your account was restored, ask the Owner to complete its sign-in setup in Accounts.';
}
