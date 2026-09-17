import { Module } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import { IntentClassifier } from './intent-classifier.service';
import { TransactionExtractor } from './transaction-extractor.service';
import { CategoryInferenceService } from './category-inference.service';
import { EditParser } from './edit-parser.service';
import { QueryInterpreter } from './query-interpreter.service';
import { SchemaValidator } from './schema-validator.service';
import { AnswerGenerator } from './answer-generator.service';

/**
 * LLM Module
 * Owns Azure AI Foundry communication, structured extraction, and validation
 */
@Module({
  providers: [
    AzureAIService,
    IntentClassifier,
    TransactionExtractor,
    CategoryInferenceService,
    EditParser,
    QueryInterpreter,
    SchemaValidator,
    AnswerGenerator,
  ],
  exports: [
    AzureAIService,
    IntentClassifier,
    TransactionExtractor,
    CategoryInferenceService,
    EditParser,
    QueryInterpreter,
    SchemaValidator,
    AnswerGenerator,
  ],
})
export class LlmModule {}
