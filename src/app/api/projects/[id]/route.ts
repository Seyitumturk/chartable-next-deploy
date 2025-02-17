import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import connectDB from '@/lib/mongodb';
import Project from '@/models/Project';
import User from '@/models/User';

export async function DELETE(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();

    const user = await User.findOne({ clerkId: userId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get project ID from URL
    const url = new URL(req.url);
    const segments = url.pathname.split('/');
    const projectId = segments[segments.indexOf('projects') + 1];

    const project = await Project.findOne({
      _id: projectId,
      userId: user._id,
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    await Project.deleteOne({ _id: projectId });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in delete project API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 