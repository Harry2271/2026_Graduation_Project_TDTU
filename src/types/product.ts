export interface Product {
  id: string;
  attributes: {
    name: string;
    description: string;
    life: {
      max: number;
      min: number;
    };
    male_weight: {
      max: number;
      min: number;
    };
    female_weight: {
      max: number;
      min: number;
    };
    hypoallergenic: boolean;
  };
}

export interface ApiResponse<T> {
  data: T;
}
