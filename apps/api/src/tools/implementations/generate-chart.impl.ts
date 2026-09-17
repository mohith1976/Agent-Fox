import { Injectable, Logger } from '@nestjs/common';
import { GenerateChartInput, GenerateChartOutput } from '../tool.types';
import { Chart, registerables } from 'chart.js';
import { createCanvas } from 'canvas';

// Register Chart.js components
Chart.register(...registerables);

/**
 * generate_chart Tool Implementation
 * Server-side chart rendering
 */
@Injectable()
export class GenerateChartImpl {
  private readonly logger = new Logger(GenerateChartImpl.name);

  /**
   * Execute generate_chart
   * Process:
   * 1. Validate input
   * 2. Create canvas
   * 3. Configure Chart.js
   * 4. Render chart
   * 5. Convert to PNG buffer
   * 6. Return image
   */
  async execute(input: GenerateChartInput): Promise<GenerateChartOutput> {
    try {
      this.logger.log(
        `Generating ${input.chartType} chart: "${input.title}"`,
      );

      // Step 1: Validate input
      if (!input.data.labels || input.data.labels.length === 0) {
        throw new Error('Chart data must have labels');
      }

      if (!input.data.datasets || input.data.datasets.length === 0) {
        throw new Error('Chart data must have at least one dataset');
      }

      const width = input.width ?? 800;
      const height = input.height ?? 600;

      // Step 2: Create canvas
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Step 3: Configure Chart.js
      const chartConfig: any = {
        type: input.chartType,
        data: input.data,
        options: {
          responsive: false,
          animation: false, // Disable animation for server-side rendering
          plugins: {
            title: {
              display: true,
              text: input.title,
              font: {
                size: 18,
              },
            },
            legend: {
              display: true,
              position: 'top',
            },
          },
        },
      };

      // Step 4: Render chart
      new Chart(ctx as any, chartConfig);

      // Step 5: Convert to PNG buffer
      const imageBuffer = canvas.toBuffer('image/png');

      this.logger.log(
        `Chart generated successfully: ${imageBuffer.length} bytes`,
      );

      return {
        imageBuffer,
        mimeType: 'image/png',
        width,
        height,
      };
    } catch (error) {
      this.logger.error(
        `generate_chart failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
