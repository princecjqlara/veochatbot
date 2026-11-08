export function signInErrorMessage(code?: string | null) {
    if (code === 'DatabaseUnavailable') return 'Sign-in is temporarily unavailable because the database is not responding. Please retry shortly.';
    if (code === 'TooManyAttempts') return 'Too many sign-in attempts. Please wait 15 minutes before trying again.';
    if (code === 'NetworkUnavailable') return 'The sign-in service could not be reached. Please retry shortly.';
    return 'Sign-in failed. Check the email and password or contact your administrator.';
}
