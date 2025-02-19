import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { OpenAI } from 'openai';
import connectDB from '@/lib/mongodb';
import Project from '@/models/Project';
import User from '@/models/User';
import GptResponse from '@/models/GptResponse';
import yaml from 'yaml';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import mermaid from 'mermaid';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORGANIZATION_ID,
});

const ARTIFICIAL_DELAY = 400;

// Load diagram definitions from YAML file
const diagramConfigPath = path.join(process.cwd(), 'src/config/diagram-definitions.yml');
const diagramConfig = yaml.parse(fs.readFileSync(diagramConfigPath, 'utf8'));

// Initialize mermaid configuration
mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
  fontFamily: 'var(--font-geist-sans)',
});

function getPromptForDiagramType(diagramType: string, userPrompt: string) {
  const config = diagramConfig.definitions[diagramType];
  
  if (!config) {
    throw new Error(`Unsupported diagram type: ${diagramType}`);
  }

  // Use the diagram-specific prompt template if available, otherwise use the default
  const promptTemplate = config.prompt_template || diagramConfig.prompts.user_template;

  return promptTemplate
    .replace('{prompt}', userPrompt)
    .replace('{diagram_type}', diagramType)
    .replace('{example}', config.example || '');
}

function getSystemPromptForDiagramType(diagramType: string) {
  const config = diagramConfig.definitions[diagramType];
  
  if (!config) {
    throw new Error(`Unsupported diagram type: ${diagramType}`);
  }

  return diagramConfig.prompts.system_template
    .replace('{diagram_type}', diagramType)
    .replace('{description}', config.description || '')
    .replace('{example}', config.example || '');
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();

    const { textPrompt, diagramType, projectId, clientSvg } = await req.json();
    
    // Add debug logging
    console.log('Received clientSvg:', clientSvg ? clientSvg.substring(0, 100) + '...' : 'No SVG received');

    // Validate diagram type
    if (!diagramConfig.definitions[diagramType]) {
      return NextResponse.json(
        { error: `Unsupported diagram type: ${diagramType}` },
        { status: 400 }
      );
    }

    // Get user and check token balance
    const user = await User.findOne({ clerkId: userId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user.wordCountBalance < 1000) {
      return NextResponse.json({ error: 'Insufficient token balance' }, { status: 403 });
    }

    // Get project
    const project = await Project.findById(projectId);
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Create a new ReadableStream
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: getSystemPromptForDiagramType(diagramType)
              },
              {
                role: "user",
                content: getPromptForDiagramType(diagramType, textPrompt)
              }
            ],
            stream: true,
            max_tokens: 4000,
            temperature: 0.7,
            presence_penalty: 0.1,
            frequency_penalty: 0.1,
            top_p: 0.95,
            response_format: { type: "text" }
          });

          let diagram = '';
          let currentChunk = '';
          let isCollectingDiagram = false;
          let lineBuffer: string[] = [];

          for await (const chunk of completion) {
            if (chunk.choices[0]?.delta?.content) {
              const content = chunk.choices[0].delta.content;
              currentChunk += content;

              // Check for the start of Mermaid syntax
              if (currentChunk.includes('```mermaid') && !isCollectingDiagram) {
                isCollectingDiagram = true;
                currentChunk = currentChunk.substring(currentChunk.indexOf('```mermaid') + 10);
                await new Promise(resolve => setTimeout(resolve, 1000));
              }

              // Check for the end of Mermaid syntax
              if (currentChunk.includes('```') && isCollectingDiagram) {
                diagram += currentChunk.substring(0, currentChunk.indexOf('```'));
                isCollectingDiagram = false;

                // Use the client-provided SVG
                const svgOutput = clientSvg;
                console.log('Using SVG for save:', svgOutput ? svgOutput.substring(0, 100) + '...' : 'No SVG to save');

                // Process any remaining lines in the buffer
                if (lineBuffer.length > 0) {
                  diagram += lineBuffer.join('\n') + '\n';
                  await new Promise(resolve => setTimeout(resolve, ARTIFICIAL_DELAY));
                  controller.enqueue(
                    `data: ${JSON.stringify({ mermaidSyntax: diagram, isComplete: false })}\n\n`
                  );
                  lineBuffer = [];
                }

                // Add final delay before completion
                await new Promise(resolve => setTimeout(resolve, 800));

                // Save with logging
                const gptResponse = new GptResponse({
                  prompt: textPrompt,
                  gptResponse: diagram,
                  extractedSyntax: diagram.trim(),
                  diagramSvg: svgOutput,
                  projectId: projectId,
                });
                await gptResponse.save();
                console.log('Saved GPT response with SVG:', gptResponse._id);

                // Save to project history
                project.history.unshift({
                  _id: new mongoose.Types.ObjectId(),
                  prompt: textPrompt,
                  diagram: diagram.trim(),
                  diagram_img: svgOutput,
                  updateType: 'chat',
                  updatedAt: new Date()
                });
                if (project.history.length > 30) {
                  project.history.pop();
                }

                // Save the latest diagram state to the project
                project.diagramSVG = svgOutput;
                project.currentDiagram = diagram.trim();
                project.markModified('history');
                console.log(">> diagrams API: Saved project.currentDiagram:", project.currentDiagram);
                await project.save();
                console.log('Saved project with SVG:', project._id);

                // Update user's token balance
                await User.findByIdAndUpdate(user._id, {
                  $inc: { wordCountBalance: -1000 }
                });

                // Send complete message
                controller.enqueue(
                  `data: ${JSON.stringify({ 
                    mermaidSyntax: diagram.trim(), 
                    isComplete: true,
                    gptResponseId: gptResponse._id.toString()
                  })}\n\n`
                );
                break;
              }

              // If we're collecting the diagram and have a complete line
              if (isCollectingDiagram && currentChunk.includes('\n')) {
                const lines = currentChunk.split('\n');
                currentChunk = lines.pop() || '';

                lineBuffer.push(...lines);

                if (lineBuffer.length >= 2) {
                  diagram += lineBuffer.join('\n') + '\n';
                  await new Promise(resolve => setTimeout(resolve, ARTIFICIAL_DELAY));
                  controller.enqueue(
                    `data: ${JSON.stringify({ mermaidSyntax: diagram, isComplete: false })}\n\n`
                  );
                  lineBuffer = [];
                }
              }
            }
          }
        } catch (error) {
          controller.error(error);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('Error in diagrams API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 