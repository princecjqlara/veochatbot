import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function POST() {
    return NextResponse.json({ error: 'Facebook connection setup has been removed. Existing VEO pages remain connected.' }, { status: 410 });
}
